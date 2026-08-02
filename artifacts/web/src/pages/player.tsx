import {
  useGetVideo,
  useUpdateVideo,
  useDeleteVideo,
  getGetVideoQueryKey,
  getListVideosQueryKey,
  getGetVideoStatsQueryKey,
} from "@workspace/api-client-react";
import { useRoute, useLocation, Link } from "wouter";
import { formatDistanceToNow, format } from "date-fns";
import { useState, useEffect, useMemo } from "react";
import { ArrowLeft, Check, Copy, Download, Edit2, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SharePanel } from "@/components/video/share-panel";
import { VisibilityBadge } from "@/components/video/visibility-badge";
import { absoluteShareUrl, shareTokenFromLocation, streamUrl } from "@/lib/video-links";

function formatBytes(bytes: number) {
  if (!+bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

export default function PlayerPage() {
  const [, params] = useRoute("/watch/:id");
  const id = params?.id ?? "";
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // A viewer arriving through a share link carries the token in the address bar;
  // the server 404s on anything non-public without it.
  const shareToken = useMemo(() => shareTokenFromLocation(), []);
  const queryParams = shareToken ? { t: shareToken } : undefined;

  const {
    data: video,
    isLoading,
    error,
  } = useGetVideo(id, queryParams, {
    query: { enabled: !!id, queryKey: getGetVideoQueryKey(id, queryParams) },
  });

  const updateVideo = useUpdateVideo();
  const deleteVideo = useDeleteVideo();

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (video && !isEditing) setEditTitle(video.title);
  }, [video, isEditing]);

  const handleSaveTitle = () => {
    if (!editTitle.trim() || editTitle === video?.title) {
      setIsEditing(false);
      return;
    }
    updateVideo.mutate(
      { id, data: { title: editTitle } },
      {
        onSuccess: (updated) => {
          setIsEditing(false);
          queryClient.setQueryData(getGetVideoQueryKey(id, queryParams), updated);
          queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        },
      },
    );
  };

  const handleDelete = () => {
    if (confirm("Delete this recording? This cannot be undone.")) {
      deleteVideo.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetVideoStatsQueryKey() });
            navigate("/library");
          },
        },
      );
    }
  };

  const handleCopyLink = async () => {
    if (!video) return;
    try {
      // Built from the record, not the address bar, so the token is always right
      // even when the page was opened from the library without one.
      await navigator.clipboard.writeText(absoluteShareUrl(video));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 p-8 flex flex-col max-w-5xl mx-auto w-full animate-pulse">
        <div className="h-5 w-28 bg-muted rounded mb-6" />
        <div className="w-full aspect-video bg-muted rounded-xl mb-6" />
        <div className="h-7 w-1/2 bg-muted rounded mb-3" />
        <div className="h-4 w-1/3 bg-muted/60 rounded" />
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-14 h-14 rounded-xl bg-secondary flex items-center justify-center text-muted-foreground mb-4">
          <Trash2 size={24} />
        </div>
        <h2 className="text-xl font-bold mb-2">Video not found</h2>
        <p className="text-muted-foreground text-sm mb-5">
          This recording doesn't exist or was deleted.
        </p>
        <Link
          href="/library"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm font-medium"
        >
          <ArrowLeft size={14} /> Back to Library
        </Link>
      </div>
    );
  }

  const videoSrc = streamUrl(video);

  return (
    <div className="flex-1 flex flex-col">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-20 flex items-center justify-between px-8 h-12 border-b border-border/60 glass-subtle shrink-0">
        <Link
          href="/library"
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={15} />
          Library
        </Link>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="glass-subtle border-0 hover:bg-accent transition-colors rounded-xl h-7 gap-1.5 text-xs"
            onClick={handleCopyLink}
          >
            {copied ? (
              <Check size={13} className="text-foreground" />
            ) : (
              <Copy size={13} />
            )}
            {copied ? "Copied!" : "Copy link"}
          </Button>
          <a href={videoSrc} download={video.filename} tabIndex={-1}>
            <Button
              variant="outline"
              size="sm"
              className="glass-subtle border-0 hover:bg-accent transition-colors rounded-xl h-7 gap-1.5 text-xs"
            >
              <Download size={13} />
              Download
            </Button>
          </a>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6 max-w-5xl mx-auto w-full">
        {/* Player */}
        <div className="w-full aspect-video bg-black rounded-xl overflow-hidden border border-border mb-6">
          <video
            src={videoSrc}
            className="w-full h-full"
            controls
            autoPlay
            playsInline
            controlsList="nodownload"
          />
        </div>

        {/* Metadata */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex-1">
            {/* Title */}
            {isEditing ? (
              <div className="flex items-center gap-2 mb-3">
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveTitle();
                    if (e.key === "Escape") {
                      setIsEditing(false);
                      setEditTitle(video.title);
                    }
                  }}
                  autoFocus
                  className="text-xl font-bold h-9 max-w-lg"
                />
                <Button
                  size="sm"
                  className="btn-gradient border-0 rounded-xl h-7 text-xs px-4"
                  onClick={handleSaveTitle}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2.5 mb-3 group/title">
                <h1 className="text-xl font-bold">{video.title}</h1>
                <button
                  onClick={() => setIsEditing(true)}
                  className="opacity-0 group-hover/title:opacity-100 p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-all"
                  title="Rename"
                >
                  <Edit2 size={14} />
                </button>
              </div>
            )}

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              <VisibilityBadge visibility={video.visibility} />
              <span>
                Recorded{" "}
                {formatDistanceToNow(new Date(video.createdAt), { addSuffix: true })}
              </span>
              <span className="text-border">·</span>
              <span>{format(new Date(video.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
              <span className="text-border">·</span>
              <span className="font-mono glass-subtle px-2 py-0.5 rounded-lg text-xs">
                {formatDuration(video.duration)}
              </span>
              <span className="font-mono glass-subtle px-2 py-0.5 rounded-lg text-xs">
                {formatBytes(video.size)}
              </span>
            </div>
          </div>

          {/* Delete */}
          <div className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl text-destructive border-destructive/20 hover:bg-destructive/5 hover:border-destructive/40 h-8 gap-1.5 text-xs"
              onClick={handleDelete}
            >
              <Trash2 size={13} />
              Delete
            </Button>
          </div>
        </div>

        {/* Sharing, visibility and Dropbox */}
        <div className="mt-6">
          <SharePanel video={video} />
        </div>
      </div>
    </div>
  );
}
