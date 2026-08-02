import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Camera,
  Cloud,
  CloudOff,
  Eye,
  Globe,
  Link2,
  Lock,
  Mic,
  MicOff,
  Play,
  RotateCcw,
  ScanEye,
  StopCircle,
  Timer,
  Upload,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getListVideosQueryKey,
  getGetVideoStatsQueryKey,
  getListDropboxFilesQueryKey,
  pushVideoToDropbox,
  useGetDropboxStatus,
  type Video as VideoRecord,
  type Visibility,
} from "@workspace/api-client-react";

import {
  applyMicConstraints,
  createMicChain,
  micConstraintsFor,
  type MicChain,
  type NoiseProfile,
} from "@/lib/media/audio-enhancer";
import {
  BackgroundProcessor,
  DEFAULT_BACKGROUND,
  type BackgroundSettings,
  type BackgroundStatus,
} from "@/lib/media/background-processor";
import { startFrameClock } from "@/lib/media/frame-clock";
import { AudioPanel } from "@/components/recorder/audio-panel";
import { BackgroundPanel } from "@/components/recorder/background-panel";
import {
  SegmentedControl,
  SettingsPanel,
  ToggleChip,
} from "@/components/recorder/capture-controls";
import { CountdownOverlay } from "@/components/recorder/countdown-overlay";
import { ReviewPanel, type CompletedTake } from "@/components/recorder/review-panel";

type CamShape = "circle" | "rounded" | "square";

/**
 * idle      - configuring, cameras may be live for preview but nothing is captured
 * countdown - screen share is up, 3-2-1 running before the first recorded frame
 * recording - MediaRecorder is collecting chunks
 * review    - a take exists; screen share is deliberately kept alive so Retake is instant
 * uploading - saving the reviewed take to the library
 */
type Phase = "idle" | "countdown" | "recording" | "review" | "uploading";

/** Why the recorder was stopped - read by `onstop`, which cannot take arguments. */
type TakeIntent = "finish" | "restart" | "discard";

// Shape helpers (used in both canvas compositing and the CSS preview bubble)
function applyCamClip(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  halfSize: number,
  shape: CamShape,
) {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(cx, cy, halfSize, 0, Math.PI * 2);
  } else if (shape === "rounded") {
    const r = halfSize * 0.22;
    // feature-detect: roundRect is modern; fall back to rect on older engines
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(cx - halfSize, cy - halfSize, halfSize * 2, halfSize * 2, r);
    } else {
      ctx.rect(cx - halfSize, cy - halfSize, halfSize * 2, halfSize * 2);
    }
  } else {
    ctx.rect(cx - halfSize, cy - halfSize, halfSize * 2, halfSize * 2);
  }
  ctx.clip();
}

function camBorderRadius(shape: CamShape, size: number): string {
  if (shape === "circle") return "50%";
  if (shape === "rounded") return `${Math.round(size * 0.22)}px`;
  return "6px";
}

/** Draws `source` into `target` with object-fit: cover semantics. */
function drawCover(
  target: HTMLCanvasElement,
  source: CanvasImageSource,
  sw: number,
  sh: number,
) {
  const ctx = target.getContext("2d");
  if (!ctx || !sw || !sh) return;
  const w = target.width;
  const h = target.height;
  ctx.clearRect(0, 0, w, h);
  const scale = Math.max(w / sw, h / sh);
  ctx.drawImage(
    source,
    (w - sw * scale) / 2,
    (h - sh * scale) / 2,
    sw * scale,
    sh * scale,
  );
}

const SIZE_PRESETS = [
  { label: "S", px: 130 },
  { label: "M", px: 200 },
  { label: "L", px: 280 },
] as const;

const COUNTDOWN_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
] as const;

const VISIBILITY_OPTIONS: {
  value: Visibility;
  label: string;
  icon: React.ElementType;
}[] = [
  { value: "private", label: "Private", icon: Lock },
  { value: "unlisted", label: "Link", icon: Link2 },
  { value: "public", label: "Public", icon: Globe },
];

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const formatTime = (total: number) => {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export default function RecorderPage() {
  // Capture configuration
  const [includeMic, setIncludeMic] = useState(true);
  const [includeWebcam, setIncludeWebcam] = useState(false);
  const [blurBehindCam, setBlurBehindCam] = useState(false);
  const [camSize, setCamSize] = useState<number>(200);
  const [camShape, setCamShape] = useState<CamShape>("circle");
  const [countdownSeconds, setCountdownSeconds] = useState<number>(3);
  const [noiseProfile, setNoiseProfile] = useState<NoiseProfile>("standard");
  const [background, setBackground] = useState<BackgroundSettings>(DEFAULT_BACKGROUND);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [autoDropbox, setAutoDropbox] = useState(false);

  // Live status
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [timer, setTimer] = useState(0);
  const [countdownValue, setCountdownValue] = useState(0);
  const [webcamActive, setWebcamActive] = useState(false);
  const [screenActive, setScreenActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [spectralActive, setSpectralActive] = useState(false);
  const [backgroundStatus, setBackgroundStatus] = useState<BackgroundStatus>("idle");
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [take, setTake] = useState<CompletedTake | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Elements
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null); // hidden segmentation source
  const camPreviewRef = useRef<HTMLCanvasElement>(null); // on-screen bubble
  const recordingCanvasRef = useRef<HTMLCanvasElement>(null);

  // Media graph
  const screenStreamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const recordedStreamRef = useRef<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micChainRef = useRef<MicChain | null>(null);
  const screenAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const bgProcessorRef = useRef<BackgroundProcessor | null>(null);

  // Recording bookkeeping
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const takeIntentRef = useRef<TakeIntent>("finish");
  const stopResolveRef = useRef<(() => void) | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const timerValueRef = useRef(0);
  const takeRef = useRef<CompletedTake | null>(null);
  const countdownCtlRef = useRef<{ skip: () => void; cancel: () => void } | null>(null);

  // Snapshots read by the render loop (refs stay fresh inside rAF)
  const phaseRef = useRef<Phase>("idle");
  const compositeArmedRef = useRef(false);
  const backgroundRef = useRef(background);
  const blurBehindCamRef = useRef(blurBehindCam);
  const camSizeRef = useRef(camSize);
  const camShapeRef = useRef(camShape);
  const webcamActiveRef = useRef(false);
  const countdownSecondsRef = useRef(countdownSeconds);
  const noiseProfileRef = useRef(noiseProfile);
  const visibilityRef = useRef<Visibility>(visibility);
  const autoDropboxRef = useRef(autoDropbox);

  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: dropboxStatus } = useGetDropboxStatus();

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  useEffect(() => {
    backgroundRef.current = background;
  }, [background]);
  useEffect(() => {
    blurBehindCamRef.current = blurBehindCam;
  }, [blurBehindCam]);
  useEffect(() => {
    camSizeRef.current = camSize;
  }, [camSize]);
  useEffect(() => {
    camShapeRef.current = camShape;
  }, [camShape]);
  useEffect(() => {
    countdownSecondsRef.current = countdownSeconds;
  }, [countdownSeconds]);
  useEffect(() => {
    visibilityRef.current = visibility;
  }, [visibility]);
  useEffect(() => {
    autoDropboxRef.current = autoDropbox;
  }, [autoDropbox]);

  // Audio context (shared by the mic chain and the recording mix)
  const ensureAudioContext = useCallback((): AudioContext => {
    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      audioDestRef.current = ctx.createMediaStreamDestination();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  }, []);

  // Webcam lifecycle - live from the moment the toggle goes on, so the
  // background can be previewed before anything is recorded.
  useEffect(() => {
    if (!includeWebcam) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = stream;
        webcamStreamRef.current = stream;
        const el = webcamVideoRef.current;
        if (el) {
          el.srcObject = stream;
          el.muted = true;
          await el.play().catch(() => {});
        }
        bgProcessorRef.current?.resetCalibration();
        webcamActiveRef.current = true;
        setWebcamActive(true);
        setDeviceError(null);
      } catch {
        if (!cancelled) {
          setDeviceError("Camera unavailable - continuing without webcam.");
          setIncludeWebcam(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      (acquired ?? webcamStreamRef.current)?.getTracks().forEach((t) => t.stop());
      webcamStreamRef.current = null;
      if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
      webcamActiveRef.current = false;
      setWebcamActive(false);
    };
  }, [includeWebcam]);

  // Microphone lifecycle + enhancement chain
  useEffect(() => {
    if (!includeMic) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    let chain: MicChain | null = null;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraintsFor(noiseProfileRef.current),
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = stream;
        micStreamRef.current = stream;

        const ctx = ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        micSourceRef.current = source;

        chain = await createMicChain(ctx, source, noiseProfileRef.current);
        if (cancelled) {
          chain.dispose();
          source.disconnect();
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micChainRef.current = chain;
        if (audioDestRef.current) chain.output.connect(audioDestRef.current);
        setSpectralActive(chain.hasSpectralStage);
      } catch {
        if (!cancelled) {
          setDeviceError("Microphone unavailable - recording without a mic.");
          setIncludeMic(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      micChainRef.current?.dispose();
      micChainRef.current = null;
      micSourceRef.current?.disconnect();
      micSourceRef.current = null;
      (acquired ?? micStreamRef.current)?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setMicLevel(0);
    };
  }, [includeMic, ensureAudioContext]);

  // Profile changes retune the live chain and the browser APM in place - no
  // reacquisition, so switching never interrupts a recording.
  useEffect(() => {
    noiseProfileRef.current = noiseProfile;
    micChainRef.current?.setProfile(noiseProfile);
    const track = micStreamRef.current?.getAudioTracks()[0];
    if (track) void applyMicConstraints(track, noiseProfile);
  }, [noiseProfile]);

  // Level meter
  useEffect(() => {
    if (!includeMic) {
      setMicLevel(0);
      return;
    }
    const id = window.setInterval(() => {
      setMicLevel(micChainRef.current?.readLevel() ?? 0);
    }, 60);
    return () => window.clearInterval(id);
  }, [includeMic]);

  // Segmentation model - created eagerly, loaded only when actually used
  useEffect(() => {
    if (!bgProcessorRef.current && BackgroundProcessor.isSupported()) {
      try {
        bgProcessorRef.current = new BackgroundProcessor();
      } catch {
        setBackgroundStatus("unsupported");
      }
    }
    return () => {
      bgProcessorRef.current?.dispose();
      bgProcessorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (background.mode === "none" || !includeWebcam) return;
    const processor = bgProcessorRef.current;
    if (!processor) {
      setBackgroundStatus("unsupported");
      return;
    }
    if (processor.status === "ready" || processor.status === "loading") {
      setBackgroundStatus(processor.status);
      return;
    }
    setBackgroundStatus("loading");
    processor
      .load()
      .then(() => setBackgroundStatus(processor.status))
      .catch(() => setBackgroundStatus("unsupported"));
  }, [background.mode, includeWebcam]);

  // The single render loop: segment -> preview bubble -> recording composite
  const drawFrame = useCallback(() => {
    const video = webcamVideoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const processor = bgProcessorRef.current;
    let source: CanvasImageSource = video;
    let sw = video.videoWidth;
    let sh = video.videoHeight;

    if (processor) {
      const output = processor.render(video, backgroundRef.current);
      source = output;
      sw = output.width;
      sh = output.height;
    }

    const preview = camPreviewRef.current;
    if (preview) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const target = Math.round(camSizeRef.current * dpr);
      if (preview.width !== target) {
        preview.width = target;
        preview.height = target;
      }
      drawCover(preview, source, sw, sh);
    }

    if (compositeArmedRef.current) {
      const canvas = recordingCanvasRef.current;
      const screenEl = screenVideoRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      if (screenEl && screenEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(screenEl, 0, 0, w, h);
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
      }

      const size = camSizeRef.current;
      const shape = camShapeRef.current;
      const half = size / 2;
      const margin = 24;
      const cx = margin + half;
      const cy = h - margin - half;

      if (blurBehindCamRef.current && screenEl) {
        ctx.save();
        applyCamClip(ctx, cx, cy, half + 20, shape);
        ctx.filter = "blur(14px)";
        ctx.drawImage(screenEl, 0, 0, w, h);
        ctx.filter = "none";
        ctx.restore();
      }

      ctx.save();
      applyCamClip(ctx, cx, cy, half, shape);
      const scale = Math.max(size / sw, size / sh);
      ctx.drawImage(
        source,
        cx - (sw * scale) / 2,
        cy - (sh * scale) / 2,
        sw * scale,
        sh * scale,
      );
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      if (shape === "circle") {
        ctx.arc(cx, cy, half, 0, Math.PI * 2);
      } else if (shape === "rounded" && typeof ctx.roundRect === "function") {
        ctx.roundRect(cx - half, cy - half, half * 2, half * 2, half * 0.22);
      } else {
        ctx.rect(cx - half, cy - half, half * 2, half * 2);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  // Not a bare rAF loop: it stops firing once the tab is hidden, which freezes
  // the composited canvas mid-recording. See lib/media/frame-clock.ts.
  useEffect(() => {
    if (!webcamActive) return;
    const clock = startFrameClock(drawFrame, {
      fps: 30,
      getAudioContext: () => audioCtxRef.current,
      getAudioSink: () => audioDestRef.current,
    });
    return () => clock.stop();
  }, [webcamActive, drawFrame]);

  // Take bookkeeping
  const setTakeSafe = useCallback((next: CompletedTake | null) => {
    if (takeRef.current) URL.revokeObjectURL(takeRef.current.url);
    takeRef.current = next;
    setTake(next);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  /** Tears down the screen share and everything derived from it. */
  const releaseCapture = useCallback(() => {
    compositeArmedRef.current = false;
    canvasStreamRef.current?.getTracks().forEach((t) => t.stop());
    canvasStreamRef.current = null;
    recordedStreamRef.current = null;
    screenAudioSourceRef.current?.disconnect();
    screenAudioSourceRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setScreenActive(false);
  }, []);

  useEffect(
    () => () => {
      // Unmount: drop absolutely everything, including devices the toggles own.
      stopTimer();
      countdownCtlRef.current?.cancel();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseCapture();
      micChainRef.current?.dispose();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      webcamStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (takeRef.current) URL.revokeObjectURL(takeRef.current.url);
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    },
    [releaseCapture, stopTimer],
  );

  // Countdown
  const runCountdown = useCallback((): Promise<boolean> => {
    const seconds = countdownSecondsRef.current;
    if (seconds <= 0) return Promise.resolve(true);

    setPhase("countdown");
    setCountdownValue(seconds);

    return new Promise<boolean>((resolve) => {
      let remaining = seconds;
      let id = 0;
      const finish = (proceed: boolean) => {
        window.clearInterval(id);
        countdownCtlRef.current = null;
        setCountdownValue(0);
        resolve(proceed);
      };
      id = window.setInterval(() => {
        remaining -= 1;
        setCountdownValue(remaining);
        if (remaining <= 0) finish(true);
      }, 1000);
      countdownCtlRef.current = { skip: () => finish(true), cancel: () => finish(false) };
    });
  }, [setPhase]);

  // Recorder control
  const handleRecorderStop = useCallback(() => {
    stopTimer();
    const intent = takeIntentRef.current;
    const chunks = chunksRef.current;
    const elapsed = timerValueRef.current;
    const recorder = mediaRecorderRef.current;
    chunksRef.current = [];
    mediaRecorderRef.current = null;

    const resolve = stopResolveRef.current;
    stopResolveRef.current = null;

    if (intent === "restart") {
      resolve?.();
      return;
    }

    if (intent === "discard" || chunks.length === 0 || elapsed < 1) {
      releaseCapture();
      setTimer(0);
      setPhase("idle");
      resolve?.();
      return;
    }

    // Plain "video/webm", not recorder.mimeType: the codec parameters break the
    // multipart header on upload. See resolveVideoMime in routes/videos.ts.
    const blob = new Blob(chunks, { type: "video/webm" });
    setTakeSafe({ blob, url: URL.createObjectURL(blob), duration: elapsed });
    setPhase("review");
    resolve?.();
  }, [releaseCapture, setPhase, setTakeSafe, stopTimer]);

  const startTake = useCallback(() => {
    const stream = recordedStreamRef.current;
    if (!stream) return;

    chunksRef.current = [];
    timerValueRef.current = 0;
    setTimer(0);
    takeIntentRef.current = "finish";

    const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(
      stream,
      mimeType
        ? { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 }
        : undefined,
    );
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = handleRecorderStop;
    recorder.start(1000);

    setPhase("recording");
    timerIntervalRef.current = window.setInterval(() => {
      timerValueRef.current += 1;
      setTimer(timerValueRef.current);
    }, 1000);
  }, [handleRecorderStop, setPhase]);

  const stopRecorder = useCallback((intent: TakeIntent): Promise<void> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return Promise.resolve();
    takeIntentRef.current = intent;
    return new Promise<void>((resolve) => {
      stopResolveRef.current = resolve;
      recorder.stop();
    });
  }, []);

  // Capture setup
  const screenIsLive = () =>
    screenStreamRef.current?.getVideoTracks()[0]?.readyState === "live";

  const prepareRecordedStream = useCallback(() => {
    const dest = audioDestRef.current;
    const screen = screenStreamRef.current;
    if (!dest || !screen) return false;

    let videoTracks: MediaStreamTrack[];
    const canvas = recordingCanvasRef.current;
    const screenEl = screenVideoRef.current;

    if (webcamActiveRef.current && canvas && screenEl) {
      canvas.width = screenEl.videoWidth || 1920;
      canvas.height = screenEl.videoHeight || 1080;
      compositeArmedRef.current = true;
      drawFrame(); // prime the canvas so captureStream starts with a real frame
      canvasStreamRef.current = canvas.captureStream(30);
      videoTracks = canvasStreamRef.current.getVideoTracks();
    } else {
      compositeArmedRef.current = false;
      videoTracks = screen.getVideoTracks();
    }

    recordedStreamRef.current = new MediaStream([
      ...videoTracks,
      ...dest.stream.getAudioTracks(),
    ]);
    return true;
  }, [drawFrame]);

  const handleScreenEnded = useCallback(() => {
    setScreenActive(false);
    const current = phaseRef.current;
    if (current === "recording") void stopRecorder("finish");
    else if (current === "countdown") countdownCtlRef.current?.cancel();
    else if (current === "idle") releaseCapture();
  }, [releaseCapture, stopRecorder]);

  const acquireScreen = useCallback(async (): Promise<boolean> => {
    if (screenIsLive()) return true;

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });
    screenStreamRef.current = stream;
    stream.getVideoTracks()[0].onended = handleScreenEnded;

    const el = screenVideoRef.current;
    if (el) {
      el.srcObject = stream;
      el.muted = true;
      await el.play().catch(() => {});
      // Dimensions are needed before the recording canvas can be sized.
      for (let i = 0; i < 40 && !el.videoWidth; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    const ctx = ensureAudioContext();
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0 && audioDestRef.current) {
      const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
      source.connect(audioDestRef.current);
      screenAudioSourceRef.current = source;
    }

    setScreenActive(true);
    return true;
  }, [ensureAudioContext, handleScreenEnded]);

  const beginRecording = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setUploadError(null);
    setDeviceError(null);
    ensureAudioContext();

    try {
      await acquireScreen();
    } catch (err) {
      // The user dismissing the source picker is a normal outcome, not an error.
      if (!(err instanceof Error) || err.name !== "NotAllowedError") {
        setDeviceError("Could not start screen capture.");
      }
      releaseCapture();
      return;
    }

    if (!prepareRecordedStream()) {
      releaseCapture();
      setDeviceError("Could not build the recording stream.");
      return;
    }

    if (!(await runCountdown())) {
      releaseCapture();
      setPhase("idle");
      return;
    }
    startTake();
  }, [
    acquireScreen,
    ensureAudioContext,
    prepareRecordedStream,
    releaseCapture,
    runCountdown,
    setPhase,
    startTake,
  ]);

  /** Discards the in-progress take and immediately runs another countdown. */
  const restartTake = useCallback(async () => {
    await stopRecorder("restart");
    setTimer(0);
    if (!(await runCountdown())) {
      releaseCapture();
      setPhase("idle");
      return;
    }
    startTake();
  }, [releaseCapture, runCountdown, setPhase, startTake, stopRecorder]);

  /** Retake from the review step - reuses the still-live screen share if it has one. */
  const retake = useCallback(async () => {
    setTakeSafe(null);
    setTimer(0);

    if (!screenIsLive()) {
      releaseCapture();
      setPhase("idle");
      await beginRecording();
      return;
    }

    if (!(await runCountdown())) {
      releaseCapture();
      setPhase("idle");
      return;
    }
    startTake();
  }, [beginRecording, releaseCapture, runCountdown, setPhase, setTakeSafe, startTake]);

  const discardTake = useCallback(() => {
    setTakeSafe(null);
    setTimer(0);
    releaseCapture();
    setPhase("idle");
  }, [releaseCapture, setPhase, setTakeSafe]);

  // Upload
  const saveTake = useCallback(() => {
    const current = takeRef.current;
    if (!current) return;

    setPhase("uploading");
    setUploadProgress(0);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", current.blob, "recording.webm");
    formData.append("title", `Screen Recording - ${new Date().toLocaleString()}`);
    formData.append("duration", String(current.duration));
    formData.append("visibility", visibilityRef.current);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        let video: VideoRecord;
        try {
          video = JSON.parse(xhr.responseText) as VideoRecord;
        } catch {
          setUploadError("Failed to parse server response");
          setPhase("review");
          return;
        }

        releaseCapture();
        setTakeSafe(null);
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetVideoStatsQueryKey() });

        // The recording is already safely in the library; a Dropbox failure must
        // not block navigation, so mirror in the background and report separately.
        if (autoDropboxRef.current) {
          void pushVideoToDropbox(video.id)
            .then(() => {
              queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
              queryClient.invalidateQueries({ queryKey: getListDropboxFilesQueryKey() });
            })
            .catch(() => {
              /* surfaced on the player page, which shows live Dropbox state */
            });
        }

        navigate(
          video.visibility === "public"
            ? `/watch/${video.id}`
            : `/watch/${video.id}?t=${encodeURIComponent(video.shareToken)}`,
        );
        return;
      }
      setUploadError(`Upload failed (${xhr.status})`);
      setPhase("review");
    };
    xhr.onerror = () => {
      setUploadError("Network error during upload");
      setPhase("review");
    };
    xhr.send(formData);
  }, [navigate, queryClient, releaseCapture, setPhase, setTakeSafe]);

  // Derived
  const isIdle = phase === "idle";
  const settingsLocked = !isIdle;

  return (
    <div className="flex-1 min-h-0 flex flex-col px-6 pt-5 pb-6 max-w-5xl mx-auto w-full">
      {/* Hidden compositing elements - always mounted so refs stay valid */}
      <video ref={webcamVideoRef} className="hidden" playsInline muted />
      <canvas ref={recordingCanvasRef} className="hidden" />

      <header className="mb-4 shrink-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">
          New recording
        </h1>
        <p className="text-muted-foreground text-sm">
          Capture your screen and share it instantly.
        </p>
      </header>

      <div className="flex-1 min-h-0 flex flex-col bg-card border border-card-border rounded-xl overflow-hidden shadow-sm">
        {/* Preview area */}
        <div className="flex-1 min-h-[150px] bg-black relative flex items-center justify-center">
          <video
            ref={screenVideoRef}
            className="w-full h-full object-contain absolute inset-0"
            autoPlay
            playsInline
            muted
          />

          {/* Webcam bubble - shows exactly what will be recorded, background and all */}
          <canvas
            ref={camPreviewRef}
            className="absolute ring-2 ring-white/50 shadow-xl z-10 pointer-events-none"
            style={{
              bottom: 24,
              left: 24,
              width: camSize,
              height: camSize,
              borderRadius: camBorderRadius(camShape, camSize),
              display: webcamActive && phase !== "review" ? "block" : "none",
            }}
          />

          {isIdle && (
            <div className="z-10 text-center flex flex-col items-center px-8">
              <div className="w-16 h-16 rounded-full border border-white/15 flex items-center justify-center text-white/45 mb-6">
                <Camera size={26} strokeWidth={1.75} />
              </div>
              <h2 className="text-xl font-semibold mb-2 text-white tracking-tight">
                Ready to record
              </h2>
              <p className="text-white/45 max-w-sm text-sm">
                Choose your screen or window in the browser prompt.
                {countdownSeconds > 0
                  ? ` A ${countdownSeconds}-second countdown runs before capture starts.`
                  : " Capture starts immediately."}
              </p>
            </div>
          )}

          {phase === "countdown" && countdownValue > 0 && (
            <CountdownOverlay
              value={countdownValue}
              onSkip={() => countdownCtlRef.current?.skip()}
              onCancel={() => countdownCtlRef.current?.cancel()}
            />
          )}

          {phase === "review" && take && (
            <video
              key={take.url}
              src={take.url}
              controls
              playsInline
              className="absolute inset-0 w-full h-full object-contain z-20 bg-black"
            />
          )}

          {phase === "uploading" && (
            <div className="z-30 absolute inset-0 bg-background/92 backdrop-blur-sm flex flex-col items-center justify-center p-8">
              <Upload size={44} className="text-primary mb-5 animate-bounce" />
              <h2 className="text-2xl font-bold mb-1">Uploading Recording</h2>
              <p className="text-muted-foreground mb-7 text-center text-sm max-w-sm">
                Saving to your local library. Please keep this tab open.
              </p>
              <div className="w-full max-w-md bg-secondary rounded-full h-2.5 overflow-hidden mb-2">
                <div
                  className="h-full bg-primary transition-all duration-200 ease-out rounded-full"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                {uploadProgress}%
              </span>
            </div>
          )}

          {phase === "recording" && (
            <div className="absolute top-4 right-4 z-20 flex items-center gap-2 bg-black/60 rounded-full px-3 py-1.5 backdrop-blur-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_6px_rgba(255,50,50,0.8)]" />
              <span className="font-mono text-sm text-white font-medium tabular-nums">
                {formatTime(timer)}
              </span>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="shrink-0 px-5 py-4 border-t border-border">
          {(deviceError || uploadError) && (
            <div className="mb-3 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span className="flex-1">{uploadError ?? deviceError}</span>
              <button
                type="button"
                className="opacity-70 hover:opacity-100"
                onClick={() => {
                  setUploadError(null);
                  setDeviceError(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {isIdle && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <ToggleChip
                  active={includeMic}
                  onToggle={() => setIncludeMic((v) => !v)}
                  activeIcon={Mic}
                  inactiveIcon={MicOff}
                  label="Microphone"
                />
                <ToggleChip
                  active={includeWebcam}
                  onToggle={() => setIncludeWebcam((v) => !v)}
                  activeIcon={Video}
                  inactiveIcon={VideoOff}
                  label="Webcam"
                />
                <ToggleChip
                  active={blurBehindCam}
                  onToggle={() => setBlurBehindCam((v) => !v)}
                  activeIcon={ScanEye}
                  inactiveIcon={Eye}
                  label="Blur behind"
                  disabled={!includeWebcam}
                />
              </div>

              {includeWebcam && (
                <div className="flex items-center gap-5 py-2 px-3 bg-muted/40 rounded-lg border border-border/60 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                      Size
                    </span>
                    <SegmentedControl<number>
                      value={camSize}
                      onChange={setCamSize}
                      options={SIZE_PRESETS.map(({ label, px }) => ({
                        value: px,
                        label,
                      }))}
                    />
                  </div>

                  <div className="w-px h-5 bg-border" />

                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                      Shape
                    </span>
                    <div className="flex gap-1">
                      {(["circle", "rounded", "square"] as CamShape[]).map((shape) => (
                        <button
                          key={shape}
                          type="button"
                          onClick={() => setCamShape(shape)}
                          title={shape.charAt(0).toUpperCase() + shape.slice(1)}
                          className={`w-8 h-8 flex items-center justify-center rounded-md border transition-all ${
                            camShape === shape
                              ? "bg-primary/10 border-primary/40"
                              : "bg-card border-border hover:border-primary/30"
                          }`}
                        >
                          <div
                            className={`w-4 h-4 ${
                              camShape === shape ? "bg-primary" : "bg-muted-foreground"
                            }`}
                            style={{
                              borderRadius:
                                shape === "circle"
                                  ? "50%"
                                  : shape === "rounded"
                                    ? "4px"
                                    : "1px",
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {camSize}px
                  </span>
                </div>
              )}

              <div className="grid gap-2.5 md:grid-cols-2">
                <BackgroundPanel
                  settings={background}
                  onChange={setBackground}
                  status={backgroundStatus}
                  webcamOff={!includeWebcam}
                  disabled={settingsLocked}
                />
                <AudioPanel
                  profile={noiseProfile}
                  onChange={setNoiseProfile}
                  level={micLevel}
                  micOn={includeMic}
                  spectralActive={spectralActive}
                  disabled={settingsLocked}
                />
              </div>

              <div className="grid gap-2.5 md:grid-cols-2">
                <SettingsPanel icon={Timer} title="Countdown">
                  <div className="flex items-center gap-3 flex-wrap">
                    <SegmentedControl<number>
                      value={countdownSeconds}
                      onChange={setCountdownSeconds}
                      options={COUNTDOWN_OPTIONS.map(({ value, label }) => ({
                        value: value as number,
                        label,
                      }))}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Runs after you pick a screen, so the picker is out of the way.
                    </p>
                  </div>
                </SettingsPanel>

                <SettingsPanel
                  icon={autoDropbox ? Cloud : CloudOff}
                  title="Sharing"
                  hint={
                    dropboxStatus?.configured === false ? (
                      <span>Dropbox not configured</span>
                    ) : dropboxStatus?.connected === false ? (
                      <span className="text-destructive">Dropbox not connected</span>
                    ) : undefined
                  }
                >
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-muted-foreground">
                        Visibility
                      </span>
                      <SegmentedControl<Visibility>
                        value={visibility}
                        onChange={setVisibility}
                        options={VISIBILITY_OPTIONS.map(
                          ({ value, label, icon: Icon }) => ({
                            value,
                            label: (
                              <span className="flex items-center gap-1.5">
                                <Icon size={12} />
                                {label}
                              </span>
                            ),
                          }),
                        )}
                      />
                    </div>

                    <ToggleChip
                      active={autoDropbox}
                      onToggle={() => setAutoDropbox((v) => !v)}
                      activeIcon={Cloud}
                      inactiveIcon={CloudOff}
                      label="Send to Dropbox on save"
                      disabled={!dropboxStatus?.connected}
                    />
                  </div>
                </SettingsPanel>
              </div>

              <div className="flex items-center justify-between gap-4 flex-wrap">
                <Button
                  size="lg"
                  className="btn-record rounded-full px-8 font-semibold border-0"
                  onClick={() => void beginRecording()}
                >
                  <span className="mr-2 inline-block w-2.5 h-2.5 rounded-full bg-white" />
                  Start recording
                </Button>
                <p className="text-xs text-muted-foreground max-w-xs text-right leading-relaxed">
                  System audio captured automatically.{" "}
                  {includeMic ? "Mic mixed in." : "Mic off."}
                </p>
              </div>
            </div>
          )}

          {phase === "countdown" && (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Button
                  size="lg"
                  className="rounded-full px-8 font-semibold"
                  onClick={() => countdownCtlRef.current?.skip()}
                >
                  <Play className="mr-2" size={17} fill="currentColor" />
                  Start now
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full w-10 h-10 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                  onClick={() => countdownCtlRef.current?.cancel()}
                  title="Cancel"
                >
                  <X size={16} />
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">Get ready...</div>
            </div>
          )}

          {phase === "recording" && (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <Button
                  variant="destructive"
                  size="lg"
                  className="rounded-full px-8 font-semibold"
                  onClick={() => void stopRecorder("finish")}
                >
                  <StopCircle className="mr-2" size={17} />
                  Stop
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="rounded-full px-6 font-semibold"
                  onClick={() => void restartTake()}
                  title="Throw this take away and start over"
                >
                  <RotateCcw className="mr-2" size={16} />
                  Restart
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full w-10 h-10 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                  onClick={() => void stopRecorder("discard")}
                  title="Cancel - discard this recording"
                >
                  <X size={16} />
                </Button>
                <span className="font-mono text-sm font-medium tabular-nums text-muted-foreground ml-1">
                  {formatTime(timer)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {includeWebcam ? `Webcam · ${camSize}px · ${camShape}` : "Screen only"}
                {includeMic ? " · Mic on" : ""}
              </div>
            </div>
          )}

          {phase === "review" && take && (
            <ReviewPanel
              take={take}
              canRetakeInstantly={screenActive}
              onRetake={() => void retake()}
              onSave={saveTake}
              onDiscard={discardTake}
            />
          )}
        </div>
      </div>
    </div>
  );
}
