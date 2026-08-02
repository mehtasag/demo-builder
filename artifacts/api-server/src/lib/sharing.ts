import { randomBytes } from "crypto";
import path from "path";

import type { Video, VideoVisibility } from "@workspace/db";

/**
 * Visibility gates shared links, not the API. There is no login, so GET /videos
 * returns share tokens for the library's own playback URLs. See the security
 * note in README.md before exposing this server.
 */

export function newShareToken(): string {
  return randomBytes(16).toString("hex");
}

/** Whether a request holding `token` may read or stream `video`. */
export function canAccess(
  video: Pick<Video, "visibility" | "shareToken">,
  token: string | undefined,
): boolean {
  if (video.visibility === "public") return true;
  return typeof token === "string" && token.length > 0 && token === video.shareToken;
}

/** Pulls the share token off a request's query string. */
export function tokenFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const raw = (query as Record<string, unknown>)["t"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/** Visibilities that should have a live Dropbox shared link. */
export function wantsDropboxLink(visibility: VideoVisibility | string): boolean {
  return visibility === "unlisted" || visibility === "public";
}

const UNSAFE_PATH_CHARS = /[/\\:?*"<>|]+/g;

/**
 * Builds a stable, readable Dropbox path for a recording.
 * The id suffix keeps two recordings with the same title from colliding, and
 * makes the remote file traceable back to a row.
 */
export function dropboxPathFor(
  video: Pick<Video, "id" | "title" | "filename">,
  folder: string,
): string {
  const extension = path.extname(video.filename) || ".webm";
  const base = video.title
    .replace(UNSAFE_PATH_CHARS, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[.\s]+$/, "");
  const safeBase = base.length > 0 ? base : "recording";
  return `${folder}/${safeBase} (${video.id.slice(0, 8)})${extension}`;
}
