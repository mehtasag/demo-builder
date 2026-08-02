import fs from "fs";
import path from "path";

import { logger } from "./logger";

/**
 * Dropbox v2 client over global fetch. Only four REST calls and an upload
 * session are needed, so the official SDK is not worth its dependency tree.
 *
 * Credentials, in priority order:
 *   1. DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN. Access
 *      tokens are minted on demand and cached until expiry.
 *   2. DROPBOX_ACCESS_TOKEN. Expires after ~4 hours; useful for a quick trial.
 *
 * DROPBOX_FOLDER (default "/DemoBuilder") is where everything is written.
 */

/** Overridable to point the client at a local stub. Leave unset in normal use. */
function apiBase(): string {
  return env("DROPBOX_API_BASE") ?? "https://api.dropboxapi.com";
}

function contentBase(): string {
  return env("DROPBOX_CONTENT_BASE") ?? "https://content.dropboxapi.com";
}

/** Dropbox requires an upload session above 150 MB; stay well under it. */
const SIMPLE_UPLOAD_LIMIT = 140 * 1024 * 1024;
/** Chunk size for session uploads. Must be a multiple of 4 MB per Dropbox docs. */
const CHUNK_SIZE = 16 * 1024 * 1024;

const VIDEO_EXTENSIONS = new Set([
  ".webm",
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".ogv",
]);

export class DropboxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DropboxError";
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function dropboxFolder(): string {
  const raw = env("DROPBOX_FOLDER") ?? "/DemoBuilder";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

export function isConfigured(): boolean {
  const hasRefresh =
    !!env("DROPBOX_APP_KEY") &&
    !!env("DROPBOX_APP_SECRET") &&
    !!env("DROPBOX_REFRESH_TOKEN");
  return hasRefresh || !!env("DROPBOX_ACCESS_TOKEN");
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Resets the cached access token. Used when a call comes back 401. */
function invalidateToken(): void {
  cachedToken = null;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const appKey = env("DROPBOX_APP_KEY");
  const appSecret = env("DROPBOX_APP_SECRET");
  const refreshToken = env("DROPBOX_REFRESH_TOKEN");

  if (appKey && appSecret && refreshToken) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const auth = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const response = await fetch(`${apiBase()}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new DropboxError(
        `Could not refresh the Dropbox access token: ${text.slice(0, 300)}`,
        response.status,
      );
    }
    const json = (await response.json()) as { access_token: string; expires_in?: number };
    cachedToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 14_400) * 1000,
    };
    return cachedToken.value;
  }

  const staticToken = env("DROPBOX_ACCESS_TOKEN");
  if (staticToken) {
    // No expiry information available; re-check every 5 minutes so a rotated
    // token is picked up without a restart.
    cachedToken = { value: staticToken, expiresAt: Date.now() + 300_000 };
    return staticToken;
  }

  throw new DropboxError(
    "Dropbox is not configured. Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and " +
      "DROPBOX_REFRESH_TOKEN (or DROPBOX_ACCESS_TOKEN) in .env - see .env.example.",
  );
}

/**
 * Dropbox passes call arguments in an HTTP header, which must be ASCII. Any
 * non-ASCII character in a filename has to be escaped or the request is rejected.
 */
function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Pulls the most useful message out of Dropbox's error envelope. */
async function describeFailure(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as {
      error_summary?: string;
      error_description?: string;
    };
    return json.error_summary ?? json.error_description ?? text;
  } catch {
    return text;
  }
}

async function rpc<T>(endpoint: string, body: unknown, retryOn401 = true): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`${apiBase()}/2${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // Dropbox rejects a JSON content-type with an empty body; send "null" instead.
    body: body === undefined ? "null" : JSON.stringify(body),
  });

  if (response.status === 401 && retryOn401) {
    invalidateToken();
    return rpc<T>(endpoint, body, false);
  }
  if (!response.ok) {
    throw new DropboxError(await describeFailure(response), response.status);
  }
  return (await response.json()) as T;
}

// Account

export interface DropboxAccount {
  email: string | null;
  name: string | null;
}

export async function getCurrentAccount(): Promise<DropboxAccount> {
  const account = await rpc<{ email?: string; name?: { display_name?: string } }>(
    "/users/get_current_account",
    undefined,
  );
  return { email: account.email ?? null, name: account.name?.display_name ?? null };
}

// Upload

interface UploadedFile {
  id: string;
  name: string;
  path_lower: string;
  size: number;
  client_modified?: string;
}

/**
 * Uploads a local file, overwriting whatever is at `dropboxPath`.
 * Streams in chunks above the simple-upload limit - screen recordings routinely
 * exceed 150 MB, where a single-shot upload is rejected outright.
 */
export async function uploadFile(
  localPath: string,
  dropboxPath: string,
): Promise<UploadedFile> {
  const stat = await fs.promises.stat(localPath);

  if (stat.size <= SIMPLE_UPLOAD_LIMIT) {
    return uploadSimple(localPath, dropboxPath);
  }
  return uploadSession(localPath, dropboxPath, stat.size);
}

async function uploadSimple(
  localPath: string,
  dropboxPath: string,
): Promise<UploadedFile> {
  const token = await getAccessToken();
  const body = await fs.promises.readFile(localPath);
  const response = await fetch(`${contentBase()}/2/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": apiArg({
        path: dropboxPath,
        mode: "overwrite",
        mute: true,
        autorename: false,
      }),
    },
    body: new Uint8Array(body),
  });
  if (!response.ok) {
    throw new DropboxError(await describeFailure(response), response.status);
  }
  return (await response.json()) as UploadedFile;
}

async function uploadSession(
  localPath: string,
  dropboxPath: string,
  size: number,
): Promise<UploadedFile> {
  const handle = await fs.promises.open(localPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let offset = 0;
    let sessionId = "";

    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      const token = await getAccessToken();

      if (offset === 0) {
        const response = await fetch(`${contentBase()}/2/files/upload_session/start`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": apiArg({ close: false }),
          },
          body: chunk,
        });
        if (!response.ok) {
          throw new DropboxError(await describeFailure(response), response.status);
        }
        sessionId = ((await response.json()) as { session_id: string }).session_id;
      } else {
        const response = await fetch(
          `${contentBase()}/2/files/upload_session/append_v2`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
              "Dropbox-API-Arg": apiArg({
                cursor: { session_id: sessionId, offset },
                close: false,
              }),
            },
            body: chunk,
          },
        );
        if (!response.ok) {
          throw new DropboxError(await describeFailure(response), response.status);
        }
      }

      offset += bytesRead;
      logger.debug({ dropboxPath, offset, size }, "Dropbox upload progress");
    }

    const token = await getAccessToken();
    const response = await fetch(`${contentBase()}/2/files/upload_session/finish`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg({
          cursor: { session_id: sessionId, offset: size },
          commit: { path: dropboxPath, mode: "overwrite", mute: true, autorename: false },
        }),
      },
      body: new Uint8Array(0),
    });
    if (!response.ok) {
      throw new DropboxError(await describeFailure(response), response.status);
    }
    return (await response.json()) as UploadedFile;
  } finally {
    await handle.close();
  }
}

// Files

export async function deleteFile(dropboxPath: string): Promise<void> {
  try {
    await rpc("/files/delete_v2", { path: dropboxPath });
  } catch (err) {
    // Already gone is a success from the caller's point of view.
    if (err instanceof DropboxError && err.message.includes("path_lookup/not_found"))
      return;
    throw err;
  }
}

export interface DropboxEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  clientModified: string | null;
  sharedUrl: string | null;
}

interface ListFolderEntry {
  [".tag"]: string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
}

/**
 * Lists every video in the configured folder, following pagination.
 * A missing folder is not an error - it just means nothing has been uploaded yet.
 */
export async function listVideos(): Promise<DropboxEntry[]> {
  const folder = dropboxFolder();
  const entries: ListFolderEntry[] = [];

  let response: { entries: ListFolderEntry[]; cursor: string; has_more: boolean };
  try {
    response = await rpc("/files/list_folder", {
      path: folder,
      recursive: false,
      limit: 2000,
    });
  } catch (err) {
    if (err instanceof DropboxError && err.message.includes("path/not_found")) return [];
    throw err;
  }
  entries.push(...response.entries);

  while (response.has_more) {
    response = await rpc("/files/list_folder/continue", { cursor: response.cursor });
    entries.push(...response.entries);
  }

  const links = await listSharedLinks(folder);

  return entries
    .filter((entry) => entry[".tag"] === "file")
    .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name ?? "").toLowerCase()))
    .map((entry) => {
      const entryPath = entry.path_display ?? entry.path_lower ?? "";
      return {
        id: entry.id ?? entryPath,
        name: entry.name ?? path.basename(entryPath),
        path: entryPath,
        size: entry.size ?? 0,
        clientModified: entry.client_modified ?? null,
        sharedUrl: links.get((entry.path_lower ?? entryPath).toLowerCase()) ?? null,
      };
    })
    .sort((a, b) => (b.clientModified ?? "").localeCompare(a.clientModified ?? ""));
}

// Shared links

interface SharedLinkMetadata {
  url: string;
  path_lower?: string;
}

/** Every existing shared link under `folderPath`, keyed by lowercased path. */
async function listSharedLinks(folderPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    let response = await rpc<{
      links: SharedLinkMetadata[];
      cursor?: string;
      has_more: boolean;
    }>("/sharing/list_shared_links", { path: folderPath, direct_only: false });

    for (;;) {
      for (const link of response.links) {
        if (link.path_lower) map.set(link.path_lower.toLowerCase(), link.url);
      }
      if (!response.has_more || !response.cursor) break;
      response = await rpc("/sharing/list_shared_links", { cursor: response.cursor });
    }
  } catch {
    // Listing links is decoration on the folder view; never fail the listing for it.
  }
  return map;
}

/** Returns the existing shared link for a path, if there is one. */
export async function getSharedLink(dropboxPath: string): Promise<string | null> {
  try {
    const response = await rpc<{ links: SharedLinkMetadata[] }>(
      "/sharing/list_shared_links",
      {
        path: dropboxPath,
        direct_only: true,
      },
    );
    return response.links[0]?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Creates a public shared link, or returns the existing one.
 * `shared_link_already_exists` is the normal response on a second call, not a failure.
 */
export async function createSharedLink(dropboxPath: string): Promise<string> {
  try {
    const response = await rpc<SharedLinkMetadata>(
      "/sharing/create_shared_link_with_settings",
      {
        path: dropboxPath,
        settings: { audience: "public", access: "viewer", allow_download: true },
      },
    );
    return response.url;
  } catch (err) {
    if (
      err instanceof DropboxError &&
      err.message.includes("shared_link_already_exists")
    ) {
      const existing = await getSharedLink(dropboxPath);
      if (existing) return existing;
    }
    throw err;
  }
}

export async function revokeSharedLink(url: string): Promise<void> {
  try {
    await rpc("/sharing/revoke_shared_link", { url });
  } catch (err) {
    if (
      err instanceof DropboxError &&
      (err.message.includes("shared_link_not_found") ||
        err.message.includes("shared_link_malformed"))
    ) {
      return;
    }
    throw err;
  }
}

/** Rewrites a share URL so it plays inline instead of opening Dropbox's viewer. */
export function toDirectUrl(sharedUrl: string): string {
  return sharedUrl.replace(/([?&])dl=0(&|$)/, "$1raw=1$2").replace(/\?$/, "");
}
