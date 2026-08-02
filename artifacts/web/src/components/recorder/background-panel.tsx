import { useEffect, useMemo, useRef } from "react";
import {
  Ban,
  ImageIcon,
  LoaderCircle,
  Sparkles,
  Upload,
  WandSparkles,
} from "lucide-react";

import {
  GRADIENT_BACKGROUNDS,
  renderGradientBackground,
  type BackgroundMode,
  type BackgroundSettings,
  type BackgroundStatus,
} from "@/lib/media/background-processor";
import { SegmentedControl, SettingsPanel } from "./capture-controls";

const BLUR_LEVELS = [
  { value: 8, label: "Light" },
  { value: 16, label: "Medium" },
  { value: 30, label: "Strong" },
] as const;

const MODES: { value: BackgroundMode; label: string; icon: React.ElementType }[] = [
  { value: "none", label: "None", icon: Ban },
  { value: "blur", label: "Blur", icon: Sparkles },
  { value: "image", label: "Replace", icon: ImageIcon },
];

/** Preset gradients are painted once and reused as ordinary background images. */
function usePresetBackgrounds() {
  return useMemo(
    () =>
      GRADIENT_BACKGROUNDS.map((spec) => ({
        ...spec,
        src: renderGradientBackground(spec),
      })),
    [],
  );
}

export function BackgroundPanel({
  settings,
  onChange,
  status,
  disabled = false,
  webcamOff,
}: {
  settings: BackgroundSettings;
  onChange: (next: BackgroundSettings) => void;
  status: BackgroundStatus;
  disabled?: boolean;
  webcamOff: boolean;
}) {
  const presets = usePresetBackgrounds();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const customUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (customUrlRef.current) URL.revokeObjectURL(customUrlRef.current);
    },
    [],
  );

  const handleUpload = (file: File | undefined) => {
    if (!file) return;
    if (customUrlRef.current) URL.revokeObjectURL(customUrlRef.current);
    const url = URL.createObjectURL(file);
    customUrlRef.current = url;
    onChange({ ...settings, mode: "image", imageSrc: url });
  };

  const hint =
    status === "loading" ? (
      <span className="flex items-center gap-1.5">
        <LoaderCircle size={11} className="animate-spin" /> Loading model...
      </span>
    ) : status === "unsupported" ? (
      <span className="text-destructive">Not supported on this browser</span>
    ) : status === "ready" ? (
      <span className="text-muted-foreground">On-device · nothing uploaded</span>
    ) : undefined;

  return (
    <SettingsPanel icon={WandSparkles} title="Background" hint={hint}>
      {webcamOff ? (
        <p className="text-xs text-muted-foreground">
          Turn the webcam on to blur or replace what is behind you.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <SegmentedControl
              value={settings.mode}
              disabled={disabled}
              onChange={(mode) =>
                onChange({
                  ...settings,
                  mode,
                  // Picking "Replace" with nothing chosen yet lands on the first preset.
                  imageSrc:
                    mode === "image" && !settings.imageSrc
                      ? presets[0].src
                      : settings.imageSrc,
                })
              }
              options={MODES.map(({ value, label, icon: Icon }) => ({
                value,
                label: (
                  <span className="flex items-center gap-1.5">
                    <Icon size={12} />
                    {label}
                  </span>
                ),
              }))}
            />

            {settings.mode === "blur" && (
              <SegmentedControl
                value={
                  BLUR_LEVELS.reduce((best, level) =>
                    Math.abs(level.value - settings.blurRadius) <
                    Math.abs(best.value - settings.blurRadius)
                      ? level
                      : best,
                  ).value
                }
                disabled={disabled}
                onChange={(blurRadius) => onChange({ ...settings, blurRadius })}
                options={BLUR_LEVELS.map(({ value, label }) => ({ value, label }))}
              />
            )}
          </div>

          {settings.mode === "image" && (
            <div className="flex items-center gap-2 flex-wrap">
              {presets.map((preset) => {
                const active = settings.imageSrc === preset.src;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={preset.label}
                    disabled={disabled}
                    onClick={() => onChange({ ...settings, imageSrc: preset.src })}
                    className={`w-14 h-9 rounded-lg overflow-hidden border-2 transition-colors disabled:opacity-40 ${
                      active
                        ? "border-foreground ring-1 ring-foreground/20"
                        : "border-border hover:border-foreground/40"
                    }`}
                  >
                    <img
                      src={preset.src}
                      alt={preset.label}
                      className="w-full h-full object-cover"
                    />
                  </button>
                );
              })}

              <button
                type="button"
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-3 flex items-center gap-1.5 rounded-lg border-2 border-dashed border-border text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground transition-colors disabled:opacity-40"
              >
                <Upload size={12} />
                Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  handleUpload(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      )}
    </SettingsPanel>
  );
}
