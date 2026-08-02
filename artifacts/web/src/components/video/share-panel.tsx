import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Cloud,
  CloudOff,
  CloudUpload,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  LoaderCircle,
  Lock,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  useUpdateVideo,
  useRotateShareToken,
  usePushVideoToDropbox,
  useRemoveVideoFromDropbox,
  useGetDropboxStatus,
  getGetVideoQueryKey,
  getListVideosQueryKey,
  getListDropboxFilesQueryKey,
  type Video,
  type Visibility,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import {
  absoluteShareUrl,
  VISIBILITY_DESCRIPTIONS,
  VISIBILITY_LABELS,
} from "@/lib/video-links";

const OPTIONS: { value: Visibility; icon: React.ElementType }[] = [
  { value: "private", icon: Lock },
  { value: "unlisted", icon: Link2 },
  { value: "public", icon: Globe },
];

/**
 * Share controls for one recording: who can watch it, the link to hand out, and
 * whether a copy lives in Dropbox.
 */
export function SharePanel({ video }: { video: Video }) {
  const queryClient = useQueryClient();

  const updateVideo = useUpdateVideo();
  const rotateToken = useRotateShareToken();
  const pushToDropbox = usePushVideoToDropbox();
  const removeFromDropbox = useRemoveVideoFromDropbox();
  const { data: dropboxStatus } = useGetDropboxStatus();

  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Every mutation returns the updated row; push it straight into the cache. */
  const applyUpdated = (updated: Video) => {
    queryClient.setQueryData(getGetVideoQueryKey(updated.id), updated);
    queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDropboxFilesQueryKey() });
  };

  const describeError = (err: unknown, fallback: string) =>
    setError(err instanceof Error && err.message ? err.message : fallback);

  const setVisibility = (visibility: Visibility) => {
    if (visibility === video.visibility) return;
    setError(null);
    updateVideo.mutate(
      { id: video.id, data: { visibility } },
      {
        onSuccess: applyUpdated,
        onError: (err) => describeError(err, "Could not change visibility"),
      },
    );
  };

  const handleRotate = () => {
    setError(null);
    rotateToken.mutate(
      { id: video.id },
      {
        onSuccess: applyUpdated,
        onError: (err) => describeError(err, "Could not reset the link"),
      },
    );
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(absoluteShareUrl(video));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard unavailable - select the link and copy it manually.");
    }
  };

  const isPrivate = video.visibility === "private";
  const shareLink = absoluteShareUrl(video);
  const dropboxBusy = pushToDropbox.isPending || removeFromDropbox.isPending;

  return (
    <section className="glass rounded-xl p-4 space-y-4">
      {/* Who can watch */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Who can watch
        </h3>
        <div className="inline-flex gap-1 p-0.5 rounded-xl bg-muted">
          {OPTIONS.map(({ value, icon: Icon }) => {
            const active = value === video.visibility;
            return (
              <button
                key={value}
                type="button"
                disabled={updateVideo.isPending}
                onClick={() => setVisibility(value)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon size={12} />
                {VISIBILITY_LABELS[value]}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          {VISIBILITY_DESCRIPTIONS[video.visibility]}
        </p>
      </div>

      {/* Share link */}
      {!isPrivate && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Share link
          </h3>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareLink}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 h-8 rounded-xl glass-subtle px-2.5 font-mono text-[11px] text-muted-foreground"
            />
            <Button
              variant="outline"
              size="sm"
              className="glass-subtle border-0 hover:bg-accent transition-colors rounded-xl h-8 gap-1.5 text-xs shrink-0"
              onClick={handleCopy}
            >
              {copied ? (
                <Check size={13} className="text-foreground" />
              ) : (
                <Copy size={13} />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="glass-subtle border-0 hover:bg-accent transition-colors rounded-xl h-8 gap-1.5 text-xs shrink-0"
              onClick={handleRotate}
              disabled={rotateToken.isPending}
              title="Issue a new link and break every link shared so far"
            >
              {rotateToken.isPending ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Reset
            </Button>
          </div>
        </div>
      )}

      {/* Dropbox */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Dropbox
        </h3>

        {!dropboxStatus?.configured ? (
          <p className="flex items-start gap-2 text-[11px] text-muted-foreground leading-relaxed">
            <CloudOff size={13} className="mt-px shrink-0" />
            Not configured. Add your Dropbox credentials to <code>.env</code> - see{" "}
            <code>.env.example</code> for the exact variables.
          </p>
        ) : !dropboxStatus.connected ? (
          <p className="flex items-start gap-2 text-[11px] text-destructive leading-relaxed">
            <CircleAlert size={13} className="mt-px shrink-0" />
            {dropboxStatus.error ?? "Dropbox credentials are not working."}
          </p>
        ) : video.dropboxPath ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">
              <Cloud size={12} />
              {video.dropboxPath}
            </span>
            {video.dropboxSharedUrl && (
              <a
                href={video.dropboxSharedUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                Open in Dropbox <ExternalLink size={11} />
              </a>
            )}
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-7 gap-1.5 text-xs ml-auto hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
              disabled={dropboxBusy}
              onClick={() => {
                setError(null);
                removeFromDropbox.mutate(
                  { id: video.id },
                  {
                    onSuccess: applyUpdated,
                    onError: (err) => describeError(err, "Could not remove from Dropbox"),
                  },
                );
              }}
            >
              {removeFromDropbox.isPending ? (
                <LoaderCircle size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="btn-gradient border-0 rounded-xl h-8 gap-1.5 text-xs px-4"
              disabled={dropboxBusy}
              onClick={() => {
                setError(null);
                pushToDropbox.mutate(
                  { id: video.id },
                  {
                    onSuccess: applyUpdated,
                    onError: (err) => describeError(err, "Could not upload to Dropbox"),
                  },
                );
              }}
            >
              {pushToDropbox.isPending ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <CloudUpload size={13} />
              )}
              {pushToDropbox.isPending ? "Uploading..." : "Send to Dropbox"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Copies to {dropboxStatus.folder}
              {dropboxStatus.accountEmail ? ` · ${dropboxStatus.accountEmail}` : ""}
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <CircleAlert size={13} className="mt-px shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            className="opacity-70 hover:opacity-100"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </p>
      )}

      <p className="text-[10px] text-muted-foreground/80 leading-relaxed border-t border-border/60 pt-3">
        Visibility governs shared links. This app has no login, so anyone who can reach
        the API directly can still list recordings - keep the server on your machine or
        behind a tunnel you control.
      </p>
    </section>
  );
}
