import { Download, RotateCcw, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface CompletedTake {
  blob: Blob;
  /** Object URL for the blob - owned by the recorder page. */
  url: string;
  /** Recorded length in seconds, from the recording timer. */
  duration: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Post-recording review step. Nothing is uploaded until the user explicitly
 * saves, so "Retake" is free - the screen share is still live underneath, and
 * a retake goes straight back into the countdown without a second picker prompt.
 */
export function ReviewPanel({
  take,
  canRetakeInstantly,
  onRetake,
  onSave,
  onDiscard,
}: {
  take: CompletedTake;
  /** False once the screen share has ended - retake will re-prompt for a source. */
  canRetakeInstantly: boolean;
  onRetake: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3">
        <Button
          size="lg"
          className="btn-gradient border-0 rounded-full px-8 font-semibold"
          onClick={onSave}
        >
          <Upload className="mr-2" size={16} />
          Save to library
        </Button>

        <Button
          variant="outline"
          size="lg"
          className="border-border bg-card hover:bg-accent transition-colors rounded-full px-6 font-semibold"
          onClick={onRetake}
          title={
            canRetakeInstantly
              ? "Discard this take and record again"
              : "Screen sharing ended - you will be asked to pick a source again"
          }
        >
          <RotateCcw className="mr-2" size={16} />
          Retake
        </Button>

        <a
          href={take.url}
          download={`recording-${Date.now()}.webm`}
          className="inline-flex items-center justify-center w-10 h-10 rounded-full border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Download without saving"
        >
          <Download size={16} />
        </a>

        <Button
          variant="outline"
          size="icon"
          className="border-border bg-card rounded-full w-10 h-10 hover:bg-destructive/10 hover:text-destructive transition-colors"
          onClick={onDiscard}
          title="Discard this recording"
        >
          <Trash2 size={16} />
        </Button>
      </div>

      <div className="text-xs text-muted-foreground text-right leading-relaxed">
        <div className="font-medium text-foreground">
          {formatDuration(take.duration)} · {formatBytes(take.blob.size)}
        </div>
        <div>
          {canRetakeInstantly
            ? "Screen still shared - retakes start instantly."
            : "Screen sharing ended - a retake will ask for a source again."}
        </div>
      </div>
    </div>
  );
}
