/**
 * Voice-activity / utterance detection for the duplex live-call bridge.
 *
 * Twilio streams the prospect's microphone continuously as 20 ms mu-law
 * frames. The conversation engine works one UTTERANCE at a time, so this
 * detector cuts the stream into turns:
 *
 *   pre-roll kept (frames before speech starts, so the first word is not
 *   clipped) -> voiced frames -> trailing silence >= silenceMs -> utterance
 *
 * Detection is energy based (RMS of the decoded frame against a threshold):
 * no model, no network, deterministic and unit-testable. A burst shorter
 * than `minSpeechMs` is discarded as noise; an utterance that never pauses
 * is force-cut at `maxUtteranceMs` so a single monologue cannot grow without
 * bound (memory stays capped at maxUtteranceMs * 8 bytes).
 *
 * The returned bytes are IN-MEMORY only: they are handed to STT for one turn
 * and dropped. Nothing in this file writes audio to disk.
 */
import { msFromUlawBytes, rms, ulawToPcm16 } from './audio.ts';

export interface VadOptions {
  /** RMS above which a frame counts as speech. */
  threshold: number;
  /** Trailing silence that ends an utterance. */
  silenceMs: number;
  /** Voiced duration below which an utterance is treated as noise. */
  minSpeechMs: number;
  /** Hard cap on a single utterance. */
  maxUtteranceMs: number;
  /** Frames of leading silence kept before speech starts (default 10 x 20 ms). */
  preRollFrames?: number;
}

export class UtteranceDetector {
  private readonly preRoll: Uint8Array[] = [];
  private readonly preRollFrames: number;
  private preRollMs = 0;
  private buffer: Uint8Array[] = [];
  private bufferedMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private readonly opts: VadOptions;

  constructor(opts: VadOptions) {
    this.opts = opts;
    this.preRollFrames = opts.preRollFrames ?? 10;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Feed one inbound mu-law frame; returns a finished utterance, if any. */
  push(payload: Uint8Array): Uint8Array | null {
    if (payload.byteLength === 0) return null;
    const frameMs = msFromUlawBytes(payload.byteLength);
    const energy = rms(ulawToPcm16(payload));

    if (!this.speaking) {
      this.rememberPreRoll(payload, frameMs);
      if (energy < this.opts.threshold) return null;
      this.speaking = true;
      this.voicedMs = 0;
      this.silenceMs = 0;
      this.buffer = [...this.preRoll];
      this.bufferedMs = this.preRollMs;
      this.preRoll.length = 0;
      this.preRollMs = 0;
      this.append(payload, frameMs);
      return null;
    }

    this.append(payload, frameMs);
    if (energy >= this.opts.threshold) {
      this.silenceMs = 0;
      this.voicedMs += frameMs;
    } else {
      this.silenceMs += frameMs;
    }

    if (this.silenceMs >= this.opts.silenceMs || this.bufferedMs >= this.opts.maxUtteranceMs) {
      return this.complete();
    }
    return null;
  }

  /** Drop everything in flight (Twilio's `clear` after a stream hiccup). */
  reset(): void {
    this.preRoll.length = 0;
    this.preRollMs = 0;
    this.buffer = [];
    this.bufferedMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
  }

  private rememberPreRoll(payload: Uint8Array, frameMs: number): void {
    this.preRoll.push(payload);
    this.preRollMs += frameMs;
    while (this.preRoll.length > this.preRollFrames) {
      const dropped = this.preRoll.shift();
      if (dropped) this.preRollMs -= msFromUlawBytes(dropped.byteLength);
    }
  }

  private append(payload: Uint8Array, frameMs: number): void {
    this.buffer.push(payload);
    this.bufferedMs += frameMs;
  }

  private complete(): Uint8Array | null {
    // Trim trailing silence (keep a small pad so the last word is intact).
    while (this.buffer.length > 1 && this.silenceMs > 60) {
      const last = this.buffer[this.buffer.length - 1]!;
      if (rms(ulawToPcm16(last)) >= this.opts.threshold) break;
      this.buffer.pop();
      this.bufferedMs -= msFromUlawBytes(last.byteLength);
      this.silenceMs -= msFromUlawBytes(last.byteLength);
    }

    const usable = this.voicedMs >= this.opts.minSpeechMs;
    const frames = this.buffer;
    this.reset();
    if (!usable) return null;

    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const frame of frames) {
      out.set(frame, at);
      at += frame.byteLength;
    }
    return out;
  }
}
