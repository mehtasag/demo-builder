/**
 * Spectral noise suppressor - runs on the audio rendering thread.
 *
 * Browsers already expose `noiseSuppression: true` on getUserMedia, but that is
 * tuned for conferencing (aggressive, low latency, no control). This worklet adds
 * a second, tunable stage on top of it:
 *
 *   1. STFT analysis (sqrt-Hann window, 1024-point FFT, 75% overlap).
 *   2. Per-bin noise floor tracking with an asymmetric follower - the estimate
 *      falls quickly toward quiet bins and rises slowly, so it locks onto
 *      steady-state noise (fans, hum, hiss, room tone) without eating speech.
 *   3. Decision-directed a-priori SNR (Ephraim-Malah) feeding a Wiener gain, with
 *      a spectral floor and 3-tap frequency smoothing to suppress musical noise.
 *   4. An optional broadband gate for the pauses between sentences.
 *   5. sqrt-Hann synthesis + overlap-add.
 *
 * Measured end-to-end latency is 896 samples (~18.7 ms at 48 kHz): the 768-sample
 * frame delay plus one 128-sample block of priming. Bypass is COLA-exact -
 * reconstruction error is float32 epsilon - so toggling the stage cannot colour
 * the signal or change the delay.
 *
 *  Why this lives in `public/` rather than `src/`
 * An AudioWorklet module cannot contain static `import` statements. Vite's dev
 * server prepends `import ".../vite/client/env.mjs"` to anything it transforms,
 * so a bundled worklet loads in production builds but fails `addModule()` under
 * `vite dev`. Files in `public/` are served byte-for-byte in both modes, which is
 * the only way to get identical behaviour. Nothing is lost by not bundling: this
 * file is self-contained and imports nothing.
 *
 * Keep the parameter shape in sync with `NoiseSuppressorParams` in
 * `src/lib/media/audio-enhancer.ts` - that module is the only caller.
 */

const FFT_SIZE = 1024;
const HOP = 256;
/** sum of (analysis x synthesis) windows across overlapping frames - sqrt-Hann pair. */
const OLA_NORM = (FFT_SIZE / HOP) * 0.5;
const HALF = FFT_SIZE / 2;
const EPS = 1e-12;

const DEFAULT_PARAMS = {
  /** Master switch. When false the STFT path becomes a pure delay line. */
  enabled: false,
  /** Noise floor is scaled by this before subtraction. Higher = more aggressive. */
  overSubtraction: 1.8,
  /** Lowest per-bin gain, linear amplitude. Lower = deeper nulls, more artifacts. */
  floorGain: 0.1,
  /** Frames below this SNR (dB) are ducked by the gate. -Infinity disables it. */
  gateThresholdDb: -Infinity,
  /** Gain applied to fully-gated frames, linear amplitude. */
  gateFloorGain: 0.12,
};

/** Iterative radix-2 complex FFT with precomputed twiddles and bit-reversal. */
class FFT {
  constructor(n) {
    this.n = n;
    const levels = Math.round(Math.log2(n));
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < levels; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r >>> 0;
    }
  }

  /** In-place forward transform. */
  forward(re, im) {
    const { n, rev, cos, sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /** In-place inverse transform (swap re/im, forward, scale). */
  inverse(re, im) {
    this.forward(im, re);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

class NoiseSuppressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.params = { ...DEFAULT_PARAMS };
    this.fft = new FFT(FFT_SIZE);
    this.window = new Float32Array(FFT_SIZE);

    /** Sliding history of input samples; the newest HOP samples sit at the end. */
    this.analysis = new Float32Array(FFT_SIZE);
    /** Overlap-add accumulator; the first HOP samples are complete each frame. */
    this.synth = new Float32Array(FFT_SIZE);

    this.re = new Float32Array(FFT_SIZE);
    this.im = new Float32Array(FFT_SIZE);

    /** Smoothed per-bin power. */
    this.power = new Float32Array(HALF + 1);
    /** Tracked per-bin noise power. */
    this.noise = new Float32Array(HALF + 1);
    /** |Ŝ|² of the previous frame, for the decision-directed SNR estimate. */
    this.prevClean = new Float32Array(HALF + 1);
    this.gain = new Float32Array(HALF + 1);
    this.smoothedGain = new Float32Array(HALF + 1);

    /** Ring buffer of processed samples waiting to be handed back to the graph. */
    this.outFifo = new Float32Array(FFT_SIZE * 4);
    this.outRead = 0;
    this.outWrite = 0;
    this.outCount = 0;

    /** Input samples accumulated since the last STFT frame. */
    this.inBlock = new Float32Array(HOP);
    this.inFill = 0;

    /** Frames seen so far - used to prime the noise estimate quickly on startup. */
    this.frameCount = 0;
    this.gateGain = 1;

    for (let i = 0; i < FFT_SIZE; i++) {
      // sqrt-Hann: applied on both analysis and synthesis so the pair sums to Hann.
      this.window[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_SIZE)));
    }
    this.noise.fill(1e-6);
    this.smoothedGain.fill(1);

    this.port.onmessage = (event) => {
      const next = event.data;
      if (next && typeof next === "object") {
        this.params = { ...this.params, ...next };
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const blockSize = output[0].length;

    if (!input || input.length === 0 || !input[0]) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    // Mics are mono in practice; downmix defensively so the DSP stays single-path.
    const mono = input[0];

    for (let i = 0; i < blockSize; i++) {
      let sample = mono[i];
      if (input.length > 1) {
        for (let c = 1; c < input.length; c++) sample += input[c][i];
        sample /= input.length;
      }

      this.inBlock[this.inFill++] = sample;

      // Slide the analysis history left by one hop and append the new block.
      if (this.inFill === HOP) {
        this.inFill = 0;
        this.analysis.copyWithin(0, HOP);
        this.analysis.set(this.inBlock, FFT_SIZE - HOP);
        this.processFrame();
      }
    }

    const available = Math.min(blockSize, this.outCount);
    const first = output[0];
    for (let i = 0; i < available; i++) {
      first[i] = this.outFifo[this.outRead];
      this.outRead = (this.outRead + 1) % this.outFifo.length;
    }
    for (let i = available; i < blockSize; i++) first[i] = 0;
    this.outCount -= available;

    for (let c = 1; c < output.length; c++) output[c].set(first);

    return true;
  }

  /** Runs one STFT frame: analyse, denoise, synthesise, overlap-add. */
  processFrame() {
    const { analysis, window, re, im, synth } = this;
    const enabled = this.params.enabled;

    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = analysis[i] * window[i];
      im[i] = 0;
    }

    if (enabled) {
      this.fft.forward(re, im);
      this.computeGains();
      const g = this.smoothedGain;
      re[0] *= g[0];
      im[0] *= g[0];
      re[HALF] *= g[HALF];
      im[HALF] *= g[HALF];
      for (let k = 1; k < HALF; k++) {
        const gk = g[k];
        re[k] *= gk;
        im[k] *= gk;
        const mirror = FFT_SIZE - k;
        re[mirror] *= gk;
        im[mirror] *= gk;
      }
      this.fft.inverse(re, im);
    }

    for (let i = 0; i < FFT_SIZE; i++) {
      synth[i] += (re[i] * window[i]) / OLA_NORM;
    }

    for (let i = 0; i < HOP; i++) {
      this.outFifo[this.outWrite] = synth[i];
      this.outWrite = (this.outWrite + 1) % this.outFifo.length;
      if (this.outCount < this.outFifo.length) {
        this.outCount++;
      } else {
        // Should not happen (production rate == consumption rate), but never
        // let a stalled graph corrupt the ring.
        this.outRead = (this.outRead + 1) % this.outFifo.length;
      }
    }

    synth.copyWithin(0, HOP);
    synth.fill(0, FFT_SIZE - HOP);

    this.frameCount++;
  }

  /** Wiener gains from a decision-directed SNR estimate, plus gate and smoothing. */
  computeGains() {
    const { re, im, power, noise, prevClean, gain, smoothedGain, params } = this;

    // The follower adapts fast for the first ~0.5 s so the estimate converges
    // before the user starts talking, then settles into its slow steady state.
    const priming = this.frameCount < (0.5 * sampleRate) / HOP;
    const noiseUp = priming ? 0.9 : 0.9995;
    const noiseDown = priming ? 0.5 : 0.85;
    const powerAlpha = 0.7;
    const ddAlpha = 0.98;

    let totalPower = 0;
    let totalNoise = 0;

    for (let k = 0; k <= HALF; k++) {
      const magSq = re[k] * re[k] + im[k] * im[k];
      const p = powerAlpha * power[k] + (1 - powerAlpha) * magSq;
      power[k] = p;

      if (p < noise[k]) {
        noise[k] = noiseDown * noise[k] + (1 - noiseDown) * p;
      } else {
        noise[k] = noiseUp * noise[k] + (1 - noiseUp) * p;
      }

      const noiseK = noise[k] * params.overSubtraction + EPS;
      const gamma = p / noiseK;
      const xi =
        ddAlpha * (prevClean[k] / noiseK) + (1 - ddAlpha) * Math.max(gamma - 1, 0);
      let g = xi / (xi + 1);
      if (g < params.floorGain) g = params.floorGain;
      else if (g > 1) g = 1;
      gain[k] = g;
      prevClean[k] = g * g * p;

      totalPower += p;
      totalNoise += noise[k];
    }

    // Broadband gate for inter-sentence pauses.
    let gateTarget = 1;
    if (params.gateThresholdDb > -Infinity) {
      const snrDb = 10 * Math.log10((totalPower + EPS) / (totalNoise + EPS));
      gateTarget = snrDb < params.gateThresholdDb ? params.gateFloorGain : 1;
    }
    // Fast open, slow close - never chop the front of a word.
    const gateAlpha = gateTarget > this.gateGain ? 0.4 : 0.96;
    this.gateGain = gateAlpha * this.gateGain + (1 - gateAlpha) * gateTarget;

    // 3-tap smoothing across frequency: the single biggest lever against the
    // "musical noise" warble that plain spectral subtraction produces.
    for (let k = 0; k <= HALF; k++) {
      const prev = gain[k > 0 ? k - 1 : 0];
      const next = gain[k < HALF ? k + 1 : HALF];
      smoothedGain[k] = (0.25 * prev + 0.5 * gain[k] + 0.25 * next) * this.gateGain;
    }
  }
}

registerProcessor("noise-suppressor", NoiseSuppressorProcessor);
