import { Cloud, Globe, Link2, Lock } from "lucide-react";
import type { Video, Visibility } from "@workspace/api-client-react";

import { VISIBILITY_LABELS } from "@/lib/video-links";

const STYLES: Record<Visibility, { icon: React.ElementType; className: string }> = {
  private: {
    icon: Lock,
    className: "bg-secondary text-secondary-foreground border-transparent",
  },
  unlisted: {
    icon: Link2,
    className: "bg-transparent text-muted-foreground border-border",
  },
  public: {
    icon: Globe,
    className: "bg-secondary text-secondary-foreground border-transparent",
  },
};

export function VisibilityBadge({
  visibility,
  compact = false,
}: {
  visibility: Visibility;
  compact?: boolean;
}) {
  const { icon: Icon, className } = STYLES[visibility];
  return (
    <span
      title={VISIBILITY_LABELS[visibility]}
      className={`inline-flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[10px] font-medium ${className}`}
    >
      <Icon size={10} />
      {!compact && VISIBILITY_LABELS[visibility]}
    </span>
  );
}

/** Small marker showing a recording is mirrored to Dropbox. */
export function DropboxBadge({ video }: { video: Pick<Video, "dropboxPath"> }) {
  if (!video.dropboxPath) return null;
  return (
    <span
      title={`In Dropbox: ${video.dropboxPath}`}
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      <Cloud size={10} />
      Dropbox
    </span>
  );
}
