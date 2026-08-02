import type { Video, Visibility } from "@workspace/api-client-react";

/**
 * URL construction for recordings.
 *
 * Anything that is not public needs `?t=<shareToken>` on both the metadata and
 * stream endpoints - the server 404s without it. These helpers are the single
 * place that rule is encoded.
 */

type Shareable = Pick<Video, "id" | "visibility" | "shareToken">;

/** Direct stream URL, carrying the token when one is required. */
export function streamUrl(video: Shareable): string {
  const base = `/api/videos/${video.id}/stream`;
  if (video.visibility === "public") return base;
  return `${base}?t=${encodeURIComponent(video.shareToken)}`;
}

/** In-app player path, carrying the token when one is required. */
export function watchPath(video: Shareable): string {
  const base = `/watch/${video.id}`;
  if (video.visibility === "public") return base;
  return `${base}?t=${encodeURIComponent(video.shareToken)}`;
}

/** Absolute URL to hand to somebody else. */
export function absoluteShareUrl(video: Shareable): string {
  const prefix = import.meta.env.BASE_URL.replace(/\/$/, "");
  return new URL(`${prefix}${watchPath(video)}`, window.location.origin).toString();
}

/** Reads the share token out of the current address bar, if present. */
export function shareTokenFromLocation(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("t");
  return value ?? undefined;
}

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Private",
  unlisted: "Anyone with the link",
  public: "Public",
};

export const VISIBILITY_DESCRIPTIONS: Record<Visibility, string> = {
  private:
    "Only reachable from this app. Switching to private issues a new token, so any link you have already shared stops working.",
  unlisted: "Plays for anyone holding the link below. Not listed anywhere public.",
  public: "Plays for anyone who knows the recording's id - no token needed.",
};
