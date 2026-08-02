import {
  useListVideos,
  useGetVideoStats,
  useDeleteVideo,
  getListVideosQueryKey,
  getGetVideoStatsQueryKey,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatDistanceToNow, format } from "date-fns";
import {
  ChevronDown,
  Film,
  LayoutGrid,
  List,
  Play,
  Plus,
  Trash2,
  Video,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
// Aliased: `Video` is already taken by the lucide icon imported above.
import type { Video as VideoRecord } from "@workspace/api-client-react";

import { DropboxBadge, VisibilityBadge } from "@/components/video/visibility-badge";
import { watchPath } from "@/lib/video-links";

// helpers
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

// Deterministic gradient per video id
const THUMB_GRADIENTS = [
  ["#7C3AED", "#4F46E5"],
  ["#2563EB", "#0891B2"],
  ["#059669", "#0D9488"],
  ["#D97706", "#DC2626"],
  ["#DB2777", "#7C3AED"],
  ["#0891B2", "#2563EB"],
  ["#7C3AED", "#DB2777"],
  ["#16A34A", "#0284C7"],
];

function thumbGradient(id: string) {
  const idx =
    id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % THUMB_GRADIENTS.length;
  const [from, to] = THUMB_GRADIENTS[idx];
  return `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}

// Video card
function VideoCard({
  video,
  onDelete,
}: {
  video: VideoRecord;
  onDelete: (id: string, title: string, e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Creator row */}
      <div className="flex items-center gap-2 mb-2 px-0.5">
        <div className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-muted-foreground text-[9px] font-bold shrink-0">
          ME
        </div>
        <span className="text-xs text-muted-foreground truncate">
          {format(new Date(video.createdAt), "MMM d, yyyy")}
        </span>
      </div>

      <Link href={watchPath(video)} className="block outline-none">
        <div className="glass rounded-xl overflow-hidden transition-colors hover:border-foreground/20">
          {/* Thumbnail */}
          <div className="relative overflow-hidden" style={{ aspectRatio: "16/9" }}>
            {/* Gradient placeholder */}
            <div
              className="absolute inset-0"
              style={{ background: thumbGradient(video.id) }}
            />

            {/* Subtle pattern overlay */}
            <div
              className="absolute inset-0 opacity-10"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)",
                backgroundSize: "20px 20px",
              }}
            />

            {/* Fake screen content silhouette */}
            <div className="absolute inset-4 rounded-lg bg-white/10 border border-white/20 flex items-center justify-center">
              <Video size={28} className="text-white/40" />
            </div>

            {/* Play overlay on hover */}
            {hovered && (
              <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center transition-opacity">
                <div className="w-12 h-12 rounded-full bg-black/70 backdrop-blur-sm flex items-center justify-center">
                  <Play size={18} fill="#fff" className="text-white ml-0.5" />
                </div>
              </div>
            )}

            {/* Duration badge */}
            <div className="absolute bottom-2 right-2 bg-black/70 text-white text-[11px] font-mono px-1.5 py-0.5 rounded-md">
              {formatDuration(video.duration)}
            </div>

            {/* Delete button on hover */}
            {hovered && (
              <button
                onClick={(e) => onDelete(video.id, video.title, e)}
                className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-black/60 text-white hover:bg-destructive flex items-center justify-center transition-colors"
                title="Delete recording"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>

          {/* Info */}
          <div className="px-3 py-3">
            <h3
              className="text-[13px] font-semibold text-foreground line-clamp-2 leading-snug mb-1.5"
              title={video.title}
            >
              {video.title}
            </h3>
            <div className="flex items-center gap-1 mb-1.5 flex-wrap">
              <VisibilityBadge visibility={video.visibility} />
              <DropboxBadge video={video} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(video.createdAt), { addSuffix: true })}
              </span>
              <span className="text-[11px] text-muted-foreground/70 font-mono">
                {formatBytes(video.size)}
              </span>
            </div>
          </div>
        </div>
      </Link>
    </div>
  );
}

// Loading skeleton card
function SkeletonCard() {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 px-0.5">
        <div className="w-5 h-5 rounded-full bg-muted animate-pulse" />
        <div className="h-3 w-20 bg-muted rounded animate-pulse" />
      </div>
      <div className="bg-card rounded-xl border border-border overflow-hidden animate-pulse">
        <div className="bg-muted" style={{ aspectRatio: "16/9" }} />
        <div className="px-3 py-3 space-y-2">
          <div className="h-3.5 bg-muted rounded w-5/6" />
          <div className="h-3 bg-muted/60 rounded w-1/2" />
        </div>
      </div>
    </div>
  );
}

// Main page
export default function LibraryPage() {
  const {
    data: videos,
    isLoading: isLoadingVideos,
    error: videosError,
  } = useListVideos();
  const { data: stats } = useGetVideoStats();
  const deleteVideo = useDeleteVideo();
  const queryClient = useQueryClient();

  const [gridView, setGridView] = useState(true);
  const [sectionOpen, setSectionOpen] = useState(true);

  const handleDelete = (id: string, title: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (confirm(`Delete "${title}"? This cannot be undone.`)) {
      deleteVideo.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetVideoStatsQueryKey() });
          },
        },
      );
    }
  };

  const count = videos?.length ?? 0;

  return (
    <div className="flex-1 flex flex-col">
      {/* Page header */}
      <div className="px-8 pt-8 pb-6 border-b border-border/60 glass-subtle">
        <div className="flex items-center justify-between max-w-7xl mx-auto w-full">
          {/* Left: icon + title */}
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-primary text-primary-foreground flex items-center justify-center">
              <Film size={28} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-[0.14em] mb-0.5">
                My Workspace
              </p>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                My Library
              </h1>
            </div>
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex items-center rounded-xl overflow-hidden glass-subtle p-0.5">
              <button
                onClick={() => setGridView(true)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${gridView ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                onClick={() => setGridView(false)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${!gridView ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <List size={15} />
              </button>
            </div>

            <button className="flex items-center gap-1.5 px-3 h-9 text-sm font-medium rounded-xl glass-subtle hover:bg-accent transition-colors text-foreground">
              <Plus size={14} />
              New folder
            </button>

            <Link
              href="/"
              className="btn-record flex items-center gap-1.5 px-4 h-9 text-sm font-semibold rounded-full"
            >
              <span className="inline-block w-2 h-2 rounded-full bg-white" />
              Record
            </Link>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-8 py-6 max-w-7xl mx-auto w-full">
        {/* Stats strip */}
        {stats && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { label: "Recordings", value: stats.totalCount, icon: Film },
              {
                label: "Total duration",
                value: formatDuration(stats.totalDurationSeconds),
                icon: Play,
              },
              {
                label: "Stored",
                value: formatBytes(stats.totalSizeBytes),
                icon: LayoutGrid,
              },
            ].map(({ label, value, icon: Icon }) => (
              <div
                key={label}
                className="glass rounded-xl px-5 py-4 flex items-center gap-4 transition-colors hover:border-foreground/20"
              >
                <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-secondary text-muted-foreground shrink-0">
                  <Icon size={20} />
                </span>
                <div className="min-w-0">
                  <p className="text-2xl font-bold tracking-tight tabular-nums leading-none">
                    {value}
                  </p>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground mt-1.5">
                    {label}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Section header */}
        {(isLoadingVideos || count > 0) && (
          <button
            className="flex items-center gap-2 mb-5 group"
            onClick={() => setSectionOpen((v) => !v)}
          >
            <h2 className="text-base font-bold text-foreground">
              My Recordings
              <span className="font-normal text-muted-foreground ml-2">({count})</span>
            </h2>
            <ChevronDown
              size={16}
              className={`text-muted-foreground transition-transform duration-200 ${sectionOpen ? "" : "-rotate-90"}`}
            />
          </button>
        )}

        {/* Grid / list */}
        {sectionOpen && (
          <>
            {videosError ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-14 h-14 rounded-xl bg-destructive/10 flex items-center justify-center text-destructive mb-4">
                  <Film size={26} />
                </div>
                <h3 className="text-base font-bold mb-1">Failed to load recordings</h3>
                <p className="text-muted-foreground text-sm mb-5 max-w-xs">
                  Something went wrong while loading your library. Please try refreshing
                  the page.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-full text-sm font-semibold hover:bg-primary/90 transition-colors"
                >
                  Refresh
                </button>
              </div>
            ) : isLoadingVideos ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : videos && videos.length > 0 ? (
              <div
                className={
                  gridView
                    ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5"
                    : "flex flex-col gap-2"
                }
              >
                {videos.map((video) =>
                  gridView ? (
                    <VideoCard key={video.id} video={video} onDelete={handleDelete} />
                  ) : (
                    /* List row */
                    <Link
                      key={video.id}
                      href={watchPath(video)}
                      className="flex items-center gap-4 glass rounded-xl px-4 py-3 hover:border-foreground/20 transition-colors group"
                    >
                      <div
                        className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center"
                        style={{ background: thumbGradient(video.id) }}
                      >
                        <Play size={14} className="text-white/80 ml-0.5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate text-foreground">
                          {video.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(video.createdAt), {
                            addSuffix: true,
                          })}
                          {" · "}
                          {formatDuration(video.duration)}
                          {" · "}
                          {formatBytes(video.size)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <VisibilityBadge visibility={video.visibility} compact />
                        <DropboxBadge video={video} />
                      </div>
                      <button
                        onClick={(e) => handleDelete(video.id, video.title, e)}
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center transition-all"
                      >
                        <Trash2 size={13} />
                      </button>
                    </Link>
                  ),
                )}
              </div>
            ) : (
              /* Empty state */
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="w-16 h-16 rounded-xl bg-secondary flex items-center justify-center text-muted-foreground mb-4">
                  <Film size={30} />
                </div>
                <h3 className="text-lg font-bold mb-1">No recordings yet</h3>
                <p className="text-muted-foreground text-sm mb-6 max-w-xs">
                  Start your first recording and it'll appear here.
                </p>
                <Link
                  href="/"
                  className="btn-record flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold"
                >
                  <span className="inline-block w-2 h-2 rounded-full bg-white" />
                  Start Recording
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
