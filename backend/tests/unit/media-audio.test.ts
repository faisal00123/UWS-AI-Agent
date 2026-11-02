/**
 * Duplex bridge unit tests: telephony audio primitives.
 *
 * Everything the bridge does with bytes is proved here without a socket or a
 * provider:
 *  - G.711 mu-law decode/encode (including byte-exact round trips and the
 *    digital-silence code), so a frame played to Twilio is the frame the
 *    synthesiser meant;
 *  - WAV write/parse for STT uploads and TTS replies, including the 8-bit
 *    telephony WAV shape the mock speech adapter returns;
 *  - resampling between the three rates that actually meet (8 / 16 / 24 kHz);
 *  - `ttsToUlaw` honesty: known formats convert, and an mp3 (which nothing in
 *    this process can decode) yields null instead of guessed audio.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  msFromUlawBytes,
  parseWav,
  pcm16ToUlaw,
  resamplePcm16,
  rms,
  s16leToPcm16,
  ttsToUlaw,
  ulawToPcm16,
  ulawToWavForStt,
  wrapWav,
} from '../../src/domain/media/audio.ts';

/** A frame of mu-law audio at a fixed amplitude. */
function frame(bytes: number, amplitude: number): Uint8Array {
  const pcm = new Int16Array(bytes).fill(amplitude);
  return pcm16ToUlaw(pcm);
}

describe('G.711 mu-law', () => {
  test('digital silence (0xFF) decodes to zero samples', () => {
    const pcm = ulawToPcm16(new Uint8Array(160).fill(0xff));
    assert.equal(pcm.length, 160);
    assert.ok(pcm.every((s) => s === 0), 'the telephony idle code must be exactly zero');
  });

  test('encoding digital silence produces 0xFF', () => {
    const encoded = pcm16ToUlaw(new Int16Array(64));
    assert.ok(encoded.every((b) => b === 0xff));
  });

  test('every code word round-trips back to itself', () => {
    for (let code = 0; code < 256; code++) {
      const decoded = ulawToPcm16(Uint8Array.of(code));
      const reencoded = pcm16ToUlaw(decoded);
      // -0 (0x7F) and +0 (0xFF) are the same Int16 value, so they collapse to
      // the positive zero code. Every other code word must be byte-exact.
      const expected = code === 0x7f ? 0xff : code;
      assert.equal(reencoded[0], expected, `code ${code} must survive decode/encode`);
    }
  });

  test('both zero code words decode to digital silence', () => {
    assert.equal(ulawToPcm16(Uint8Array.of(0x7f))[0], 0);
    assert.equal(ulawToPcm16(Uint8Array.of(0xff))[0], 0);
    assert.equal(ulawToPcm16(Uint8Array.of(0x00))[0], -32124, '0x00 is the loudest negative code');
    assert.equal(ulawToPcm16(Uint8Array.of(0x80))[0], 32124, '0x80 is the loudest positive code');
  });

  test('positive and negative samples keep their sign and approximate level', () => {
    const positive = ulawToPcm16(pcm16ToUlaw(Int16Array.of(4000)))[0]!;
    const negative = ulawToPcm16(pcm16ToUlaw(Int16Array.of(-4000)))[0]!;
    assert.ok(positive > 3000 && positive < 5000, `expected ~4000, got ${positive}`);
    assert.ok(negative < -3000 && negative > -5000, `expected ~-4000, got ${negative}`);
  });

  test('frame duration is derived from the byte count (20 ms = 160 bytes)', () => {
    assert.equal(msFromUlawBytes(160), 20);
    assert.equal(msFromUlawBytes(8000), 1000);
  });

  test('rms reports silence as zero and a tone as energetic', () => {
    assert.equal(rms(ulawToPcm16(new Uint8Array(320).fill(0xff))), 0, '0xFF is the telephony idle code');
    const tone = new Int16Array(320).fill(6000);
    assert.ok(rms(tone) > 400, 'a 6000-amplitude frame must exceed the VAD threshold');
  });
});

describe('WAV', () => {
  test('wrapWav -> parseWav is lossless for 16-bit mono', () => {
    const pcm = new Int16Array(500);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 7) * 20_000);
    const parsed = parseWav(wrapWav(pcm, 16_000));
    assert.ok(parsed);
    assert.equal(parsed.sampleRate, 16_000);
    assert.deepEqual([...parsed.pcm], [...pcm]);
  });

  test('an 8-bit telephony WAV (mock provider shape) decodes to 16-bit', () => {
    const wav = wrapWav(Int16Array.of(0), 8000); // header only, rebuilt by hand below
    assert.ok(wav.byteLength >= 44);
    // Build an 8-bit unsigned WAV: 128 = centre, 255 = loud positive.
    const body = Uint8Array.of(128, 255, 0);
    const out = new Uint8Array(44 + body.length);
    out.set(wrapWav(new Int16Array(0), 8000), 0);
    out.set(body, 44);
    const view = new DataView(out.buffer);
    view.setUint16(20, 1, true); // format = PCM
    view.setUint16(34, 8, true); // 8 bits per sample
    view.setUint32(28, 8000, true); // byte rate
    view.setUint16(32, 1, true); // block align
    view.setUint32(40, body.length, true);

    const parsed = parseWav(out);
    assert.ok(parsed);
    assert.equal(parsed.sampleRate, 8000);
    assert.equal(parsed.pcm.length, 3);
    assert.equal(parsed.pcm[0], 0, 'mid-scale byte is silence');
    assert.equal(parsed.pcm[1], 127 << 8, 'top byte is the loudest positive');
    assert.equal(parsed.pcm[2], -128 << 8, 'bottom byte is the loudest negative');
  });

  test('non-WAV bytes are refused instead of guessed at', () => {
    assert.equal(parseWav(Uint8Array.from({ length: 64 }, (_, i) => i)), null);
    assert.equal(parseWav(new Uint8Array(4)), null);
  });

  test('s16le parsing reads little-endian signed samples', () => {
    const bytes = Uint8Array.of(0x00, 0x10, 0xff, 0xff);
    const pcm = s16leToPcm16(bytes);
    assert.deepEqual([...pcm], [0x1000, -1]);
  });
});

describe('resampling', () => {
  test('8 kHz -> 16 kHz doubles the stream', () => {
    const input = new Int16Array(160).fill(1000);
    const out = resamplePcm16(input, 8000, 16_000);
    assert.equal(out.length, 320);
    assert.equal(out[0], 1000);
    assert.equal(out[319], 1000);
  });

  test('24 kHz -> 8 kHz divides the stream by three', () => {
    const input = new Int16Array(720).fill(2000);
    const out = resamplePcm16(input, 24_000, 8000);
    assert.equal(out.length, 240);
  });

  test('same rate is returned untouched', () => {
    const input = Int16Array.of(1, 2, 3);
    assert.equal(resamplePcm16(input, 8000, 8000), input);
  });

  test('clipping is prevented on extremes', () => {
    const out = resamplePcm16(Int16Array.of(-32768, 32767), 8000, 16_000);
    assert.ok([...out].every((v) => v >= -32768 && v <= 32767));
  });
});

describe('ttsToUlaw', () => {
  test('a WAV reply converts to telephony frames', () => {
    const pcm = new Int16Array(1600).fill(3000);
    const out = ttsToUlaw(wrapWav(pcm, 8000), 'audio/wav');
    assert.ok(out);
    assert.equal(out.length, 1600, '8 kHz input needs no resample');
    assert.equal(rms(ulawToPcm16(out)) > 400, true, 'the energy must survive the conversion');
  });

  test('raw PCM at 24 kHz is resampled to 8 kHz', () => {
    const pcm = new Int16Array(7200).fill(3000); // 0.3 s at 24 kHz
    const bytes = new Uint8Array(pcm.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
    const out = ttsToUlaw(bytes, 'audio/pcm', 24_000);
    assert.ok(out);
    assert.equal(out.length, 2400, '7200 samples at 24 kHz = 2400 samples at 8 kHz');
  });

  test('content type parameters are ignored', () => {
    const out = ttsToUlaw(wrapWav(new Int16Array(160).fill(1000), 8000), 'audio/wav; rate=8000');
    assert.ok(out);
    assert.equal(out.length, 160);
  });

  test('mp3 bytes are refused — nothing here can decode them', () => {
    const fakeMp3 = new Uint8Array(512).fill(0x11);
    assert.equal(ttsToUlaw(fakeMp3, 'audio/mpeg', 8000), null);
    assert.equal(ttsToUlaw(new Uint8Array(0), 'audio/wav'), null);
  });
});

describe('ulawToWavForStt', () => {
  test('produces a parseable 16 kHz WAV twice the length of the 8 kHz input', () => {
    const source = frame(320, 5000); // 40 ms of speech
    const wav = ulawToWavForStt(source);
    const parsed = parseWav(wav);
    assert.ok(parsed);
    assert.equal(parsed.sampleRate, 16_000);
    assert.equal(parsed.pcm.length, 640);
    assert.ok(rms(parsed.pcm) > 400, 'speech energy must reach the recogniser');
  });
});
