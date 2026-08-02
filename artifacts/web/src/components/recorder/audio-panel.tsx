import { AudioLines } from "lucide-react";

import {
  NOISE_PROFILES,
  NOISE_PROFILE_ORDER,
  type NoiseProfile,
} from "@/lib/media/audio-enhancer";
import { SegmentedControl, SettingsPanel } from "./capture-controls";

/** Post-processing level meter - 24 segments, green through amber to red. */
function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const segments = 24;
  const lit = active ? Math.round(level * segments) : 0;
  return (
    <div className="flex items-center gap-[2px] h-3" aria-hidden>
      {Array.from({ length: segments }, (_, i) => {
        const on = i < lit;
        const color =
          i > segments * 0.9
            ? "bg-destructive"
            : i > segments * 0.72
              ? "bg-amber-500"
              : "bg-primary";
        return (
          <span
            key={i}
            className={`w-[3px] rounded-full transition-all duration-75 ${
              on ? `${color} h-3` : "bg-border h-1.5"
            }`}
          />
        );
      })}
    </div>
  );
}

export function AudioPanel({
  profile,
  onChange,
  level,
  micOn,
  spectralActive,
  disabled = false,
}: {
  profile: NoiseProfile;
  onChange: (profile: NoiseProfile) => void;
  level: number;
  micOn: boolean;
  /** Whether the worklet stage actually loaded - false means browser NS only. */
  spectralActive: boolean;
  disabled?: boolean;
}) {
  const config = NOISE_PROFILES[profile];
  const wantsSpectral = config.worklet.enabled;

  return (
    <SettingsPanel
      icon={AudioLines}
      title="Noise cancellation"
      hint={
        wantsSpectral && !spectralActive ? (
          <span className="text-amber-500">Spectral stage unavailable</span>
        ) : undefined
      }
    >
      {!micOn ? (
        <p className="text-xs text-muted-foreground">
          Turn the microphone on to enable noise cancellation.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <SegmentedControl
              value={profile}
              disabled={disabled}
              onChange={onChange}
              options={NOISE_PROFILE_ORDER.map((value) => ({
                value,
                label: NOISE_PROFILES[value].label,
                title: NOISE_PROFILES[value].description,
              }))}
            />
            <div className="ml-auto flex items-center gap-2">
              <LevelMeter level={level} active={micOn} />
              <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">
                {Math.round(level * 100)}%
              </span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {config.description}
          </p>
        </div>
      )}
    </SettingsPanel>
  );
}
