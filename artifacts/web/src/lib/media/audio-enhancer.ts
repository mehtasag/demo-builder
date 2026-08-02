/**
 * Served verbatim from `public/` - see the header of that file for why it cannot
 * go through the bundler.
 */
const NOISE_SUPPRESSOR_URL = `${
  import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
}worklets/noise-suppressor.js`;

/**
 * Microphone enhancement chain.
 *
 *   source -> highpass -> [noise-suppressor worklet] -> compressor -> makeup -> analyser
 *
 * Each profile tunes three layers at once: the browser's own APM (via track
 * constraints), our spectral suppressor (via worklet params), and the tone /
 * dynamics nodes around it.
 */

export type NoiseProfile = "off" | "standard" | "strong" | "studio";

export const NOISE_PROFILE_ORDER: readonly NoiseProfile[] = [
  "off",
  "standard",
  "strong",
  "studio",
] as const;

interface ProfileConfig {
  label: string;
  description: string;
  /** Browser APM constraints handed to getUserMedia. */
  constraints: MediaTrackConstraints;
  /** Chrome-only voice isolation; applied best-effort after the track opens. */
  voiceIsolation: boolean;
  /** Rumble / handling-noise filter. */
  highpassHz: number;
  compressor: { threshold: number; ratio: number; knee: number };
  makeupGain: number;
  worklet: NoiseSuppressorParams;
}

export interface NoiseSuppressorParams {
  enabled: boolean;
  overSubtraction: number;
  floorGain: number;
  gateThresholdDb: number;
  gateFloorGain: number;
}

export const NOISE_PROFILES: Record<NoiseProfile, ProfileConfig> = {
  off: {
    label: "Raw",
    description: "No processing - the microphone signal exactly as captured.",
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    voiceIsolation: false,
    highpassHz: 20,
    compressor: { threshold: 0, ratio: 1, knee: 0 },
    makeupGain: 1,
    worklet: {
      enabled: false,
      overSubtraction: 1,
      floorGain: 1,
      gateThresholdDb: -Infinity,
      gateFloorGain: 1,
    },
  },
  standard: {
    label: "Standard",
    description: "Browser echo cancellation, noise suppression and auto gain.",
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    voiceIsolation: false,
    highpassHz: 80,
    compressor: { threshold: -24, ratio: 3, knee: 12 },
    makeupGain: 1.25,
    worklet: {
      enabled: false,
      overSubtraction: 1,
      floorGain: 1,
      gateThresholdDb: -Infinity,
      gateFloorGain: 1,
    },
  },
  strong: {
    label: "Strong",
    description: "Adds spectral suppression for fans, hum, traffic and room tone.",
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    voiceIsolation: false,
    highpassHz: 100,
    compressor: { threshold: -26, ratio: 3.5, knee: 10 },
    makeupGain: 1.35,
    worklet: {
      enabled: true,
      overSubtraction: 1.8,
      floorGain: 0.1,
      gateThresholdDb: -Infinity,
      gateFloorGain: 0.12,
    },
  },
  studio: {
    label: "Studio",
    description:
      "Maximum suppression plus voice isolation and a gate on the pauses. Best for noisy rooms.",
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    voiceIsolation: true,
    highpassHz: 120,
    compressor: { threshold: -28, ratio: 4, knee: 8 },
    makeupGain: 1.5,
    worklet: {
      enabled: true,
      overSubtraction: 3,
      floorGain: 0.04,
      gateThresholdDb: 4,
      gateFloorGain: 0.06,
    },
  },
};

/**
 * getUserMedia audio constraints for a profile.
 *
 * `voiceIsolation` is a Chromium extension that hands the mic to the OS/browser
 * speech isolator - a much stronger separator than the conferencing-grade APM.
 * It is folded into the same constraint set because `applyConstraints` replaces
 * the whole set, so it can never be applied as a second, separate call.
 */
export function micConstraintsFor(profile: NoiseProfile): MediaTrackConstraints {
  const config = NOISE_PROFILES[profile];
  const constraints: Record<string, unknown> = { ...config.constraints };
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() as
    | Record<string, boolean | undefined>
    | undefined;
  if (supported?.voiceIsolation) constraints.voiceIsolation = config.voiceIsolation;
  return constraints as MediaTrackConstraints;
}

/** Retunes a live track to a different profile. Best-effort - never throws. */
export async function applyMicConstraints(
  track: MediaStreamTrack,
  profile: NoiseProfile,
): Promise<void> {
  try {
    await track.applyConstraints(micConstraintsFor(profile));
  } catch {
    // The device may not support live reconfiguration; the Web Audio stages
    // still switch, which is where most of the difference comes from anyway.
  }
}

export interface MicChain {
  /** Terminal node of the chain - connect this to your recording destination. */
  readonly output: AudioNode;
  /** Post-processing analyser, for level meters. */
  readonly analyser: AnalyserNode;
  /** True when the spectral worklet stage actually loaded. */
  readonly hasSpectralStage: boolean;
  setProfile(profile: NoiseProfile): void;
  /** Current post-processing level, 0-1, suitable for a meter. */
  readLevel(): number;
  dispose(): void;
}

let workletModulePromise: Promise<void> | null = null;

/** `addModule` is idempotent per context, but we only ever use one context. */
async function ensureWorkletModule(ctx: AudioContext): Promise<void> {
  if (!ctx.audioWorklet) throw new Error("AudioWorklet unavailable");
  if (!workletModulePromise) {
    workletModulePromise = ctx.audioWorklet
      .addModule(NOISE_SUPPRESSOR_URL)
      .catch((err) => {
        workletModulePromise = null;
        throw err;
      });
  }
  return workletModulePromise;
}

/**
 * Builds the enhancement chain. The graph shape is fixed and profile changes only
 * retune parameters, so switching profiles mid-session never clicks or drops audio.
 */
export async function createMicChain(
  ctx: AudioContext,
  source: AudioNode,
  profile: NoiseProfile,
): Promise<MicChain> {
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.Q.value = 0.7;

  const compressor = ctx.createDynamicsCompressor();
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;

  const makeup = ctx.createGain();

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;

  let suppressor: AudioWorkletNode | null = null;
  try {
    await ensureWorkletModule(ctx);
    suppressor = new AudioWorkletNode(ctx, "noise-suppressor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
  } catch {
    // Fall back to the browser's own suppression only.
    suppressor = null;
  }

  source.connect(highpass);
  if (suppressor) {
    highpass.connect(suppressor);
    suppressor.connect(compressor);
  } else {
    highpass.connect(compressor);
  }
  compressor.connect(makeup);
  makeup.connect(analyser);

  const levelBuffer = new Float32Array(analyser.fftSize);

  const chain: MicChain = {
    output: analyser,
    analyser,
    hasSpectralStage: suppressor !== null,

    setProfile(next: NoiseProfile) {
      const config = NOISE_PROFILES[next];
      const now = ctx.currentTime;
      highpass.frequency.setTargetAtTime(config.highpassHz, now, 0.02);
      compressor.threshold.setTargetAtTime(config.compressor.threshold, now, 0.02);
      compressor.ratio.setTargetAtTime(config.compressor.ratio, now, 0.02);
      compressor.knee.setTargetAtTime(config.compressor.knee, now, 0.02);
      makeup.gain.setTargetAtTime(config.makeupGain, now, 0.02);
      suppressor?.port.postMessage(config.worklet);
    },

    readLevel() {
      analyser.getFloatTimeDomainData(levelBuffer);
      let sum = 0;
      for (let i = 0; i < levelBuffer.length; i++) sum += levelBuffer[i] * levelBuffer[i];
      const rms = Math.sqrt(sum / levelBuffer.length);
      // -60 dBFS ... 0 dBFS mapped to 0...1.
      const db = 20 * Math.log10(rms + 1e-8);
      return Math.min(1, Math.max(0, (db + 60) / 60));
    },

    dispose() {
      try {
        source.disconnect(highpass);
      } catch {
        /* already torn down */
      }
      highpass.disconnect();
      suppressor?.disconnect();
      suppressor?.port.close();
      compressor.disconnect();
      makeup.disconnect();
      analyser.disconnect();
    },
  };

  chain.setProfile(profile);
  return chain;
}
