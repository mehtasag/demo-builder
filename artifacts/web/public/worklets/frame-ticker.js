/**
 * Counts render quanta and posts a tick at the requested frame rate. The audio
 * thread keeps running while the tab is hidden, so this survives backgrounding
 * where rAF does not. See src/lib/media/frame-clock.ts for the rationale.
 *
 * Outputs silence, but must stay connected to a rendered node or the graph
 * will not pull from it.
 */
class FrameTickerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const fps = options?.processorOptions?.fps ?? 30;
    // Never tick more often than one render quantum.
    this.framesPerTick = Math.max(128, Math.round(sampleRate / fps));
    this.elapsed = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const quantum = output?.[0]?.length ?? 128;

    this.elapsed += quantum;
    if (this.elapsed >= this.framesPerTick) {
      // Subtract rather than zero: framesPerTick is rarely a whole number of
      // 128-sample quanta (48000/30 = 1600 = 12.5 quanta), and discarding the
      // overshoot each tick makes the clock run measurably slow.
      this.elapsed -= this.framesPerTick;
      this.port.postMessage(0);
    }

    // Explicit silence - outputs are zero-filled already, but be unambiguous
    // about contributing nothing to the recorded audio.
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }
}

registerProcessor("frame-ticker", FrameTickerProcessor);
