/**
 * Frame clock that keeps ticking while the tab is in the background.
 *
 * rAF stops firing once the document is hidden, which freezes
 * canvas.captureStream() on its last frame. Visible tabs use rAF; hidden tabs
 * use ticks from an AudioWorklet, since the audio thread runs regardless of
 * visibility. setInterval is a last resort only: background timers are clamped
 * to 1s.
 */

const TICKER_URL = `${
  import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
}worklets/frame-ticker.js`;

export interface FrameClock {
  stop(): void;
  /** Which source last drove a tick - surfaced for diagnostics. */
  readonly source: () => "raf" | "audio" | "interval";
}

export interface FrameClockOptions {
  fps?: number;
  /** Looked up lazily: the context often does not exist when the clock starts. */
  getAudioContext: () => AudioContext | null;
  /** Node the silent ticker connects to; must be part of a rendered graph. */
  getAudioSink: () => AudioNode | null;
}

const moduleLoads = new WeakMap<AudioContext, Promise<void>>();

function loadTickerModule(ctx: AudioContext): Promise<void> {
  let load = moduleLoads.get(ctx);
  if (!load) {
    load = ctx.audioWorklet.addModule(TICKER_URL);
    moduleLoads.set(ctx, load);
  }
  return load;
}

export function startFrameClock(
  onTick: () => void,
  { fps = 30, getAudioContext, getAudioSink }: FrameClockOptions,
): FrameClock {
  const minGap = 1000 / fps / 2;
  let stopped = false;
  let lastTick = 0;
  let lastSource: "raf" | "audio" | "interval" = "raf";

  /**
   * Both clocks can be live at once (rAF while visible, ticker always). Dedupe
   * so a frame is never composited twice in quick succession.
   */
  const tick = (source: "raf" | "audio" | "interval") => {
    if (stopped) return;
    const now = performance.now();
    if (now - lastTick < minGap) return;
    lastTick = now;
    lastSource = source;
    onTick();
  };

  // Visible path
  let raf = 0;
  const rafLoop = () => {
    raf = requestAnimationFrame(rafLoop);
    tick("raf");
  };
  raf = requestAnimationFrame(rafLoop);

  // Hidden path: audio-thread ticker
  let ticker: AudioWorkletNode | null = null;
  let silence: GainNode | null = null;
  let attaching = false;

  const attachAudioTicker = () => {
    if (stopped || ticker || attaching) return;
    const ctx = getAudioContext();
    const sink = getAudioSink();
    if (!ctx || !sink) return;

    attaching = true;
    void loadTickerModule(ctx)
      .then(() => {
        if (stopped || ticker) return;
        const node = new AudioWorkletNode(ctx, "frame-ticker", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { fps },
        });
        node.port.onmessage = () => tick("audio");

        // Zero gain: the ticker must be pulled by a rendered destination, but
        // must not contribute a sample to the recorded mix.
        const gain = ctx.createGain();
        gain.gain.value = 0;
        node.connect(gain);
        gain.connect(sink);

        ticker = node;
        silence = gain;
        if (interval !== null) {
          window.clearInterval(interval);
          interval = null;
        }
      })
      .catch(() => {
        // Fall through to the interval fallback below.
      })
      .finally(() => {
        attaching = false;
      });
  };

  // Hidden path fallback: throttled, but better than a frozen frame
  let interval: number | null = null;
  const startIntervalFallback = () => {
    if (stopped || ticker || interval !== null) return;
    interval = window.setInterval(() => tick("interval"), 1000 / fps);
  };

  // Try immediately, then again when the graph is likely to exist. The clock is
  // usually started before the AudioContext is created (webcam preview precedes
  // the screen-share prompt), so a single attempt would always miss.
  attachAudioTicker();
  const retry = window.setInterval(() => {
    if (ticker) {
      window.clearInterval(retry);
      return;
    }
    attachAudioTicker();
  }, 500);

  const onVisibilityChange = () => {
    if (document.visibilityState !== "hidden") return;
    // Last chance to get a background-safe clock before rAF goes quiet.
    attachAudioTicker();
    if (!ticker) startIntervalFallback();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    source: () => lastSource,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(retry);
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (ticker) {
        ticker.port.onmessage = null;
        ticker.disconnect();
      }
      silence?.disconnect();
      ticker = null;
      silence = null;
    },
  };
}
