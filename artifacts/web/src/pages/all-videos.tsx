import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Check,
  CircleAlert,
  Cloud,
  CloudOff,
  CloudUpload,
  ExternalLink,
  HardDrive,
  Layers,
  LoaderCircle,
  Play,
  Search,
} from "lucide-react";
import {
  useListVideos,
  useListDropboxFiles,
  useGetDropboxStatus,
  usePushVideoToDropbox,
  getListVideosQueryKey,
  getListDropboxFilesQueryKey,
  getGetVideoQueryKey,
  type DropboxFile,
  type Video,
  type Visibility,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { VisibilityBadge } from "@/components/video/visibility-badge";
import { watchPath } from "@/lib/video-links";

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

/**
 * A row in the combined view. `local` and `dropbox` are both optional: a
 * recording can exist on only one side.
 */
interface CombinedRow {
  key: string;
  title: string;
  size: number;
  date: string | null;
  local: Video | null;
  dropbox: DropboxFile | null;
}

type SourceFilter = "all" | "local" | "dropbox" | "synced" | "unsynced";

/**
 * Joins local recordings to Dropbox folder contents on the stored Dropbox path.
 * Anything left over in Dropbox - files this app never uploaded, or uploads
 * whose local row was deleted - is surfaced rather than hidden.
 */
function combine(videos: Video[], files: DropboxFile[]): CombinedRow[] {
  const byPath = new Map<string, DropboxFile>();
  for (const file of files) byPath.set(file.path.toLowerCase(), file);

  const rows: CombinedRow[] = videos.map((video) => {
    const path = video.dropboxPath?.toLowerCase();
    const match = path ? (byPath.get(path) ?? null) : null;
    if (match) byPath.delete(path!);
    return {
      key: `local:${video.id}`,
      title: video.title,
      size: video.size,
      date: new Date(video.createdAt).toISOString(),
      local: video,
      dropbox: match,
    };
  });

  for (const file of byPath.values()) {
    rows.push({
      key: `dropbox:${file.id}`,
      title: file.name,
      size: file.size,
      date: file.clientModified ? new Date(file.clientModified).toISOString() : null,
      local: null,
      dropbox: file,
    });
  }

  return rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

function SyncBadge({ row }: { row: CombinedRow }) {
  if (row.local && row.dropbox) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-foreground">
        <Check size={10} /> Synced
      </span>
    );
  }
  if (row.local) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <HardDrive size={10} /> Local only
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      <Cloud size={10} /> Dropbox only
    </span>
  );
}

export default function AllVideosPage() {
  const queryClient = useQueryClient();

  const { data: videos, isLoading: loadingVideos } = useListVideos();
  const { data: dropboxListing, isLoading: loadingDropbox } = useListDropboxFiles();
  const { data: dropboxStatus } = useGetDropboxStatus();
  const pushToDropbox = usePushVideoToDropbox();

  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [visibility, setVisibility] = useState<Visibility | "any">("any");
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () => combine(videos ?? [], dropboxListing?.files ?? []),
    [videos, dropboxListing],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle && !row.title.toLowerCase().includes(needle)) return false;
      if (visibility !== "any" && row.local?.visibility !== visibility) return false;
      switch (source) {
        case "local":
          return !!row.local;
        case "dropbox":
          return !!row.dropbox;
        case "synced":
          return !!row.local && !!row.dropbox;
        case "unsynced":
          return !!row.local && !row.dropbox;
        default:
          return true;
      }
    });
  }, [rows, query, source, visibility]);

  const unsynced = rows.filter((row) => row.local && !row.dropbox);

  const pushOne = (video: Video) =>
    new Promise<void>((resolve) => {
      setPushingId(video.id);
      pushToDropbox.mutate(
        { id: video.id },
        {
          onSuccess: (updated) => {
            queryClient.setQueryData(getGetVideoQueryKey(updated.id), updated);
          },
          onError: (err) => {
            setError(
              err instanceof Error && err.message
                ? `${video.title}: ${err.message}`
                : `Could not upload "${video.title}"`,
            );
          },
          onSettled: () => {
            setPushingId(null);
            resolve();
          },
        },
      );
    });

  /** Uploads sequentially - parallel large uploads just contend for bandwidth. */
  const pushAllUnsynced = async () => {
    setError(null);
    for (const row of unsynced) {
      if (row.local) await pushOne(row.local);
    }
    queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDropboxFilesQueryKey() });
  };

  const isLoading = loadingVideos || loadingDropbox;

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div className="px-8 pt-8 pb-6 border-b border-border/60 glass-subtle">
        <div className="flex items-center justify-between max-w-7xl mx-auto w-full gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-primary text-primary-foreground flex items-center justify-center">
              <Layers size={28} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-0.5">
                Everywhere
              </p>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                All Videos
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {dropboxStatus?.connected && unsynced.length > 0 && (
              <Button
                size="sm"
                className="btn-gradient border-0 rounded-xl h-8 gap-1.5 text-xs px-4"
                onClick={() => void pushAllUnsynced()}
                disabled={pushToDropbox.isPending}
              >
                {pushToDropbox.isPending ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <CloudUpload size={13} />
                )}
                Upload {unsynced.length} to Dropbox
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="px-8 py-4 border-b border-border max-w-7xl mx-auto w-full flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles..."
            className="h-8 w-56 rounded-xl glass-subtle pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </div>

        <select
          value={source}
          onChange={(event) => setSource(event.target.value as SourceFilter)}
          className="h-8 rounded-xl glass-subtle px-2 text-xs outline-none focus:ring-1 focus:ring-foreground/20"
        >
          <option value="all">All sources</option>
          <option value="local">On this machine</option>
          <option value="dropbox">In Dropbox</option>
          <option value="synced">Synced (both)</option>
          <option value="unsynced">Not yet in Dropbox</option>
        </select>

        <select
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as Visibility | "any")}
          className="h-8 rounded-xl glass-subtle px-2 text-xs outline-none focus:ring-1 focus:ring-foreground/20"
        >
          <option value="any">Any visibility</option>
          <option value="private">Private</option>
          <option value="unlisted">Anyone with the link</option>
          <option value="public">Public</option>
        </select>

        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} of {rows.length}
        </span>
      </div>

      {/* Dropbox connection notice */}
      {dropboxStatus && !dropboxStatus.configured && (
        <div className="px-8 pt-4 max-w-7xl mx-auto w-full">
          <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <CloudOff size={14} className="shrink-0" />
            Dropbox is not configured - showing local recordings only. Add credentials to{" "}
            <code className="font-mono">.env</code> (see{" "}
            <code className="font-mono">.env.example</code>) and restart the API server.
          </p>
        </div>
      )}
      {dropboxListing?.error && dropboxStatus?.configured && (
        <div className="px-8 pt-4 max-w-7xl mx-auto w-full">
          <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <CircleAlert size={14} className="shrink-0" />
            {dropboxListing.error}
          </p>
        </div>
      )}
      {error && (
        <div className="px-8 pt-4 max-w-7xl mx-auto w-full">
          <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <CircleAlert size={14} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </p>
        </div>
      )}

      {/* Rows */}
      <div className="flex-1 px-8 py-5 max-w-7xl mx-auto w-full">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 rounded-xl bg-secondary flex items-center justify-center text-muted-foreground mb-4">
              <Layers size={26} />
            </div>
            <h3 className="text-base font-bold mb-1">Nothing matches</h3>
            <p className="text-muted-foreground text-sm max-w-xs">
              {rows.length === 0
                ? "Record something, or upload a video to your Dropbox folder."
                : "Try a different search or filter."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((row) => {
              const body = (
                <>
                  <div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center bg-secondary text-muted-foreground">
                    {row.local ? (
                      <Play size={14} className="ml-0.5" />
                    ) : (
                      <Cloud size={15} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-foreground">
                      {row.title}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {row.date
                        ? formatDistanceToNow(new Date(row.date), { addSuffix: true })
                        : "Unknown date"}
                      {row.local ? ` · ${formatDuration(row.local.duration)}` : ""}
                      {` · ${formatBytes(row.size)}`}
                      {row.dropbox ? ` · ${row.dropbox.path}` : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {row.local && (
                      <VisibilityBadge visibility={row.local.visibility} compact />
                    )}
                    <SyncBadge row={row} />
                  </div>
                </>
              );

              return (
                <div
                  key={row.key}
                  className="flex items-center gap-4 glass rounded-xl px-4 py-3 transition-colors hover:border-foreground/20"
                >
                  {row.local ? (
                    <Link
                      href={watchPath(row.local)}
                      className="flex items-center gap-4 flex-1 min-w-0"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-4 flex-1 min-w-0">{body}</div>
                  )}

                  {/* Per-row actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {row.local && !row.dropbox && dropboxStatus?.connected && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="glass-subtle border-0 hover:bg-accent transition-colors rounded-xl h-7 gap-1.5 text-xs"
                        disabled={pushToDropbox.isPending}
                        onClick={() => {
                          setError(null);
                          void pushOne(row.local!).then(() => {
                            queryClient.invalidateQueries({
                              queryKey: getListVideosQueryKey(),
                            });
                            queryClient.invalidateQueries({
                              queryKey: getListDropboxFilesQueryKey(),
                            });
                          });
                        }}
                      >
                        {pushingId === row.local.id ? (
                          <LoaderCircle size={12} className="animate-spin" />
                        ) : (
                          <CloudUpload size={12} />
                        )}
                        Upload
                      </Button>
                    )}
                    {row.dropbox?.sharedUrl && (
                      <a
                        href={row.dropbox.sharedUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Open in Dropbox"
                        className="w-7 h-7 rounded-xl glass-subtle flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
