/**
 * Duplex bridge unit tests: voice-activity / utterance detection.
 *
 * The detector is what turns a continuous Twilio media stream into turns the
 * conversation engine can process, so its behaviour is pinned down here:
 *  - silence never produces an utterance (no empty STT calls);
 *  - speech followed by the configured trailing silence produces exactly one
 *    utterance, including the clipped-in leading frames;
 *  - a noise burst shorter than the minimum voiced duration is discarded;
 *  - an utterance that never pauses is force-cut at the hard cap;
 *  - `clear` (Twilio's stream hiccup signal) drops everything in flight.
 *
 * Frames are synthesised through the same G.711 encoder the bridge plays
 * back, so these tests exercise the real byte path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pcm16ToUlaw, rms, ulawToPcm16 } from '../../src/domain/media/audio.ts';
import { UtteranceDetector, type VadOptions } from '../../src/domain/media/vad.ts';

const FRAME = 160; // 20 ms at 8 kHz

function frame(amplitude: number, bytes = FRAME): Uint8Array {
  return pcm16ToUlaw(new Int16Array(bytes).fill(amplitude));
}

const OPTIONS: VadOptions = {
  threshold: 400,
  silenceMs: 600,
  minSpeechMs: 250,
  maxUtteranceMs: 5_000,
};

function push(detector: UtteranceDetector, amplitude: number, frames: number): Uint8Array | null {
  let utterance: Uint8Array | null = null;
  for (let i = 0; i < frames; i++) {
    const out = detector.push(frame(amplitude));
    if (out) utterance = out;
  }
  return utterance;
}

describe('UtteranceDetector', () => {
  test('pure silence never yields an utterance', () => {
    const detector = new UtteranceDetector(OPTIONS);
    for (let i = 0; i < 100; i++) assert.equal(detector.push(frame(0)), null);
    assert.equal(detector.isSpeaking, false);
  });

  test('speech then trailing silence yields exactly one utterance', () => {
    const detector = new UtteranceDetector(OPTIONS);
    assert.equal(push(detector, 5_000, 20), null, 'speech alone must not cut the turn early (400 ms so far)');
    assert.equal(detector.isSpeaking, true);
    const utterance = push(detector, 0, 40); // 800 ms of silence
    assert.ok(utterance, 'the turn must end once the silence threshold is crossed');
    assert.ok(utterance.byteLength > 0);
    assert.ok(
      rms(ulawToPcm16(utterance)) > 400,
      'the recorded turn must contain the voiced audio, not only silence',
    );
    assert.equal(detector.isSpeaking, false, 'the detector returns to idle after a turn');
    assert.equal(push(detector, 0, 40), null, 'trailing silence cannot start a second turn');
  });

  test('a noise burst below the minimum voiced duration is discarded', () => {
    const detector = new UtteranceDetector(OPTIONS);
    assert.equal(detector.push(frame(5_000)), null, 'one 20 ms frame is never a turn');
    assert.equal(push(detector, 0, 40), null, 'a burst under minSpeechMs produces nothing');
  });

  test('the hard cap force-cuts an utterance that never pauses', () => {
    const detector = new UtteranceDetector({ ...OPTIONS, maxUtteranceMs: 400 });
    let utterance: Uint8Array | null = null;
    for (let i = 0; i < 40 && !utterance; i++) utterance = detector.push(frame(5_000));
    assert.ok(utterance, 'a monologue must be cut at the cap instead of growing forever');
    assert.ok(utterance.byteLength <= 400 * 8, 'the buffer stays within the configured bound');
    assert.equal(detector.isSpeaking, false);
  });

  test('pre-roll keeps the frames immediately before speech started', () => {
    const detector = new UtteranceDetector(OPTIONS);
    for (let i = 0; i < 5; i++) detector.push(frame(0)); // 100 ms of lead-in
    assert.equal(detector.push(frame(5_000)), null);
    const utterance = push(detector, 5_000, 19); // 380 ms more voice -> 400 ms total
    assert.equal(utterance, null, 'still inside the turn');
    const closed = push(detector, 0, 40);
    assert.ok(closed);
    // 5 pre-roll frames (100 ms) + ~400 ms of voice, all at 8000 bytes/second.
    assert.ok(closed.byteLength > (5 + 20) * FRAME, `leading frames must be retained (got ${closed.byteLength})`);
    assert.equal(detector.isSpeaking, false);
  });

  test('reset clears an in-progress utterance', () => {
    const detector = new UtteranceDetector(OPTIONS);
    push(detector, 5_000, 10);
    assert.equal(detector.isSpeaking, true);
    detector.reset();
    assert.equal(detector.isSpeaking, false);
    assert.equal(detector.push(frame(0)), null);
  });

  test('short frames are measured by their real duration', () => {
    // A 40 ms frame counts as 40 ms: 5 voiced frames (200 ms) + trailing
    // silence still needs the full silence window to close the turn.
    const detector = new UtteranceDetector({ ...OPTIONS, minSpeechMs: 250 });
    for (let i = 0; i < 5; i++) detector.push(frame(5_000, 320));
    assert.equal(detector.push(frame(0, 320)), null, '200 ms of voice is still below minSpeechMs');
  });
});
