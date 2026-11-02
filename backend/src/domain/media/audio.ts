/**
 * Telephony audio primitives for the duplex live-call bridge.
 *
 * Twilio Media Streams speak G.711 mu-law, 8 kHz, one byte per sample. The
 * conversation engine speaks text, and the speech providers speak WAV/PCM.
 * This module is the boundary between those three worlds:
 *
 *   mu-law <-> PCM16  ITU-T G.711 (encode is derived FROM decode, so a value
 *                     always round-trips to the same code word)
 *   WAV parse/create  RIFF handling for STT uploads and for TTS replies
 *   resampling        linear interpolation (8 <-> 16 <-> 24 kHz)
 *   energy            RMS, used by the voice-activity detector
 *
 * Pure functions only: no I/O, no provider calls, no configuration — every
 * line here is unit-testable in isolation. NOTHING in this file persists
 * audio: call audio lives in memory for the duration of a turn and is never
 * written to disk (recording requires explicit prospect consent).
 */

// ------------------------------------------------------------- G.711 -------

/** Reconstructed magnitude for one mu-law code word (0 .. 32124). */
function decodeUlawByte(u: number): { negative: boolean; magnitude: number } {
  // Complement first: the sign/segment/mantissa fields are stored inverted.
  const v = ~u & 0xff;
  const exponent = (v >> 4) & 0x07;
  const mantissa = v & 0x0f;
  const magnitude = ((mantissa << 3) + 0x84) * 2 ** exponent - 0x84;
  return { negative: (v & 0x80) !== 0, magnitude };
}

/** Inverse of the table above: nearest POSITIVE code word for a magnitude. */
let nearestPositiveCode: Uint8Array | null = null;

function magnitudeTable(): Uint8Array {
  if (nearestPositiveCode) return nearestPositiveCode;
  const levels: { magnitude: number; code: number }[] = [];
  for (let code = 0x80; code <= 0xff; code++) {
    levels.push({ magnitude: decodeUlawByte(code).magnitude, code });
  }
  levels.sort((a, b) => a.magnitude - b.magnitude);
  const table = new Uint8Array(32768);
  let i = 0;
  for (let x = 0; x < table.length; x++) {
    while (i + 1 < levels.length && levels[i + 1]!.magnitude <= x) i++;
    const low = levels[i]!;
    const high = levels[i + 1];
    table[x] = high && high.magnitude - x < x - low.magnitude ? high.code : low.code;
  }
  nearestPositiveCode = table;
  return table;
}

/** Decode one mu-law frame (one byte per sample) into signed 16-bit PCM. */
export function ulawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const { negative, magnitude } = decodeUlawByte(bytes[i]!);
    out[i] = negative ? -magnitude : magnitude;
  }
  return out;
}

/** Encode signed 16-bit PCM into mu-law (the exact inverse of `ulawToPcm16`). */
export function pcm16ToUlaw(pcm: Int16Array): Uint8Array {
  const table = magnitudeTable();
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i]!;
    const magnitude = Math.min(Math.abs(sample), 32767);
    const positive = table[magnitude]!;
    out[i] = sample < 0 ? positive ^ 0x80 : positive;
  }
  return out;
}

/** Sample count per millisecond of mu-law telephony audio. */
export function msFromUlawBytes(byteLength: number): number {
  return byteLength / 8; // 8000 samples/second, 1 byte each
}

// ---------------------------------------------------------- resampling -----

/**
 * Linear-interpolation resample. Used for the two rates that actually meet:
 * 8 kHz telephony <-> 16 kHz STT and 24 kHz TTS <-> 8 kHz telephony.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0 || fromRate <= 0 || toRate <= 0) return input;
  const step = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / step));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const i0 = Math.min(Math.floor(position), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const fraction = position - i0;
    const a = input[i0]!;
    const b = input[i1]!;
    const value = Math.round(a + (b - a) * fraction);
    out[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
  return out;
}

/** Root-mean-square energy of a PCM frame (drives voice-activity detection). */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

// ------------------------------------------------------------- WAV ----------

export interface PcmAudio {
  pcm: Int16Array;
  sampleRate: number;
}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/**
 * Parse a RIFF/WAVE file into mono 16-bit PCM.
 * Supports PCM (format 1) at 8/16/24/32 bit and mu-law (format 7); stereo is
 * downmixed. Returns null for anything else (mp3/ogg/float) — a caller must
 * never guess at bytes it cannot interpret.
 */
export function parseWav(buf: Uint8Array): PcmAudio | null {
  if (buf.byteLength < 44) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const id = tag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body > buf.byteLength) break;
    if (id === 'fmt ' && body + 16 <= buf.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || sampleRate <= 0 || channels <= 0) return null;

  const bytes = buf.subarray(dataOffset, dataOffset + dataLength);
  let mono: Int16Array;

  if (format === 7) {
    if (bits !== 8) return null;
    mono = ulawToPcm16(bytes);
  } else if (format === 1) {
    if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
    const frameBytes = bits / 8;
    const frames = Math.floor(bytes.length / frameBytes / channels);
    mono = new Int16Array(frames);
    for (let f = 0; f < frames; f++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        const at = (f * channels + c) * frameBytes;
        let value: number;
        if (bits === 8) {
          value = (bytes[at]! - 128) << 8;
        } else if (bits === 16) {
          value = view.getInt16(dataOffset + at, true);
        } else if (bits === 24) {
          const raw = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
          value = (raw << 8) >> 16;
        } else {
          value = view.getInt32(dataOffset + at, true) >> 16;
        }
        acc += value;
      }
      mono[f] = Math.round(acc / channels);
    }
  } else {
    return null;
  }
  return { pcm: mono, sampleRate };
}

/** Serialise mono 16-bit PCM as a canonical 44-byte-header WAV file. */
export function wrapWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeTag = (offset: number, text: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

/** Raw little-endian s16le bytes -> PCM. */
export function s16leToPcm16(bytes: Uint8Array): Int16Array {
  const frames = Math.floor(bytes.length / 2);
  const out = new Int16Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frames; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// -------------------------------------------------- provider audio -> ------

/**
 * Convert synthesised speech into mu-law frames the telephony layer can play.
 *
 * Returns null when the byte stream cannot be interpreted (for example an
 * mp3 from a provider that ignored the `pcm` format request) — silence is
 * never substituted for speech, and bytes are never guessed at.
 */
export function ttsToUlaw(audio: Uint8Array, contentType: string, sampleRate?: number): Uint8Array | null {
  if (audio.byteLength === 0) return null;
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();

  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave' || type === 'audio/vnd.wave') {
    const parsed = parseWav(audio);
    if (!parsed) return null;
    return pcm16ToUlaw(toTelephonyRate(parsed.pcm, parsed.sampleRate));
  }
  if (type === 'audio/pcm' || type === 'audio/x-pcm' || type === 'audio/l16' || type === 'audio/raw') {
    return pcm16ToUlaw(toTelephonyRate(s16leToPcm16(audio), sampleRate ?? 24_000));
  }
  if (type === 'audio/mulaw' || type === 'audio/ulaw') {
    // Already telephony audio (mu-law, 8 kHz assumed).
    return audio;
  }
  return null;
}

function toTelephonyRate(pcm: Int16Array, rate: number): Int16Array {
  return rate === 8000 ? pcm : resamplePcm16(pcm, rate, 8000);
}

/**
 * Inbound call audio for STT: mu-law 8 kHz -> 16 kHz WAV (the rate speech
 * recognisers expect). The buffer is transient — it is uploaded for
 * transcription and never stored.
 */
export function ulawToWavForStt(muLaw: Uint8Array, targetRate = 16_000): Uint8Array {
  const pcm8k = ulawToPcm16(muLaw);
  const pcm = targetRate === 8000 ? pcm8k : resamplePcm16(pcm8k, 8000, targetRate);
  return wrapWav(pcm, targetRate);
}
