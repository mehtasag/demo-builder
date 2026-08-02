import { X } from "lucide-react";

/**
 * Full-bleed 3-2-1 countdown shown between "Start Recording" and the first
 * recorded frame, so the screen picker dialog is gone and the user is composed
 * before capture begins.
 */
export function CountdownOverlay({
  value,
  onSkip,
  onCancel,
}: {
  value: number;
  onSkip: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/75 backdrop-blur-md">
      <div
        // `key` restarts the animation on every tick.
        key={value}
        className="text-white font-bold tabular-nums select-none animate-in zoom-in-50 fade-in duration-300"
        style={{ fontSize: "clamp(5rem, 18vw, 11rem)", lineHeight: 1 }}
      >
        {value}
      </div>
      <p className="text-white/70 text-sm mt-4">Recording starts in...</p>

      <div className="flex items-center gap-2 mt-8">
        <button
          type="button"
          onClick={onSkip}
          className="btn-record inline-flex items-center px-5 py-2 rounded-full text-sm font-medium"
        >
          <span className="mr-2 inline-block w-2 h-2 rounded-full bg-white" />
          Start now
        </button>
        <button
          type="button"
          onClick={onCancel}
          title="Cancel"
          className="w-9 h-9 rounded-full flex items-center justify-center bg-white/10 text-white/80 hover:bg-destructive/80 hover:text-white transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
