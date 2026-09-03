/**
 * The tab recorder's audio tap — an AudioWorklet processor.
 *
 * WHY A SEPARATE BUNDLED FILE, not a Blob URL: `audioWorklet.addModule()` loads a
 * script, and an MV3 extension page's CSP is `script-src 'self'`. A `blob:` URL is
 * not `'self'`, so addModule(blobUrl) is blocked — the same reason MV3 killed
 * `eval` and inline scripts. A file that ships in the extension IS `'self'`, so
 * this is its own esbuild entry (build.mjs) emitting dist/recorder-worklet.js, and
 * the offscreen document loads it by relative URL. It needs no
 * web_accessible_resources: the offscreen document is same-origin with it.
 *
 * The job is small and must stay small — this runs on the audio thread, where
 * anything slow is a dropout in the file:
 *   - interleave the render quanta into fixed ~100 ms frames (InterleavedFramer),
 *   - measure peak (the silence gates) and RMS (the level meter),
 *   - post the frame's buffer to the offscreen document, TRANSFERRED (no copy).
 *
 * Nothing is encoded here and nothing is judged here. The gates live on the other
 * side of the port so their thresholds sit with the rest of the recorder.
 */

import {
  InterleavedFramer,
  framePeak,
  frameRms,
} from '../../shared/audio/tab-recording';

// AudioWorklet's globals are not in lib.dom, so declare exactly what is used.
declare const registerProcessor: (name: string, ctor: unknown) => void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** What the offscreen document receives per frame. */
export interface RecorderFrameMessage {
  pcm: ArrayBuffer;
  peak: number;
  rms: number;
}

interface RecorderOptions {
  processorOptions?: { channels?: number; frameSize?: number };
}

class TabRecorderProcessor extends AudioWorkletProcessor {
  private readonly channels: number;
  private readonly framer: InterleavedFramer;
  /** A channel-count surprise is reported once, not once per 128 samples. */
  private warned = false;

  constructor(options?: RecorderOptions) {
    super();
    const opts = options?.processorOptions ?? {};
    this.channels = opts.channels && opts.channels > 0 ? Math.floor(opts.channels) : 2;
    const frameSize = opts.frameSize && opts.frameSize > 0 ? Math.floor(opts.frameSize) : 4800;
    this.framer = new InterleavedFramer(this.channels, frameSize);
    // Stopping tears the graph down, which would strand whatever partial frame is
    // held here (< 100 ms). The offscreen document asks for it first, so the tail
    // of the recording is the tail of the audio.
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data && event.data.flush) this.emit(this.framer.flush());
    };
  }

  private emit(frame: Float32Array | null): void {
    if (!frame || frame.length === 0) return;
    const message: RecorderFrameMessage = {
      pcm: frame.buffer as ArrayBuffer,
      peak: framePeak(frame),
      rms: frameRms(frame)
    };
    // Transfer, don't copy: at 48 kHz stereo this is 38 KB every 100 ms and it is
    // leaving the audio thread.
    this.port.postMessage(message, [message.pcm]);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // No connected input this quantum (the graph is being torn down): nothing to
    // record, but stay alive — returning false would retire the node for good.
    if (!input || input.length === 0) return true;

    let channelData = input;
    if (input.length !== this.channels) {
      // Should be impossible: the node is created with channelCountMode
      // 'explicit', so the input is always up/down-mixed to `channels`. If it
      // ever isn't, pad or trim rather than corrupt the interleave — and say so.
      if (!this.warned) {
        this.warned = true;
        this.port.postMessage({
          warning: `tab capture delivered ${input.length} channels, expected ${this.channels}`
        });
      }
      const fixed: Float32Array[] = [];
      for (let c = 0; c < this.channels; c++) fixed.push(input[Math.min(c, input.length - 1)]);
      channelData = fixed;
    }

    for (const frame of this.framer.push(channelData)) this.emit(frame);
    // The output stays silent on purpose — the tab is kept audible by a separate
    // source → destination edge, and this node only exists to be pulled.
    return true;
  }
}

registerProcessor('bf-tab-recorder', TabRecorderProcessor);
