import path from "path";
import fs from "fs";
import { Router, type IRouter } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { eq, sum, count, desc } from "drizzle-orm";
import { db, videosTable, VIDEO_VISIBILITIES, type VideoVisibility } from "@workspace/db";
import {
  ListVideosResponse,
  UploadVideoResponse,
  GetVideoStatsResponse,
  GetVideoParams,
  GetVideoResponse,
  UpdateVideoParams,
  UpdateVideoBody,
  UpdateVideoResponse,
  DeleteVideoParams,
} from "@workspace/api-zod";

import * as dropbox from "../lib/dropbox";
import { logger } from "../lib/logger";
import {
  canAccess,
  dropboxPathFor,
  newShareToken,
  tokenFromQuery,
  wantsDropboxLink,
} from "../lib/sharing";

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const VIDEO_EXTENSIONS = new Set([
  ".webm",
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".ogv",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".ogv": "video/ogg",
};

/**
 * Decides the Content-Type to store and serve.
 *
 * The browser-reported type cannot be trusted here. A MediaRecorder blob is
 * typed "video/webm;codecs=vp9,opus", and that unquoted comma breaks the
 * multipart part header - busboy gives up and reports "text/plain". Serving a
 * video as text/plain leaves players unable to decode it, so fall back to the
 * filename whenever the reported type is not a video type.
 *
 * Applied on read as well as write, so recordings stored with a mangled type
 * before this fix start playing again without a migration.
 */
function resolveVideoMime(reported: string | null | undefined, filename: string): string {
  if (reported && reported.startsWith("video/")) {
    // Strip codec parameters: they are informational and trip strict parsers.
    return reported.split(";")[0].trim();
  }
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? "video/webm";
}

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (_req, file, cb) => {
    // Accept on either the MIME type or the extension. See resolveVideoMime
    // above for why the reported type is unreliable.
    const okMime = file.mimetype.startsWith("video/");
    const okExt = VIDEO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase());
    if (okMime || okExt) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

const router: IRouter = Router();

type VideoRow = typeof videosTable.$inferSelect;

// GET /videos
router.get("/videos", async (_req, res): Promise<void> => {
  const videos = await db.select().from(videosTable).orderBy(desc(videosTable.createdAt));
  res.json(ListVideosResponse.parse(videos.map(toApiVideo)));
});

// POST /videos
router.post("/videos", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No video file provided" });
    return;
  }

  const id = randomUUID();
  const title =
    (typeof req.body.title === "string" && req.body.title.trim()) ||
    `Recording ${new Date().toLocaleString()}`;

  // The recorder knows the real elapsed time; a webm from MediaRecorder has no
  // seekable duration in its header, so the client is the only source for this.
  const parsedDuration = Number.parseInt(String(req.body.duration ?? ""), 10);
  const duration =
    Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;

  const requested = String(req.body.visibility ?? "");
  const visibility: VideoVisibility = isVisibility(requested) ? requested : "private";

  const [video] = await db
    .insert(videosTable)
    .values({
      id,
      title,
      filename: req.file.filename,
      mimeType: resolveVideoMime(req.file.mimetype, req.file.originalname),
      size: req.file.size,
      duration,
      visibility,
      shareToken: newShareToken(),
    })
    .returning();

  res.status(201).json(UploadVideoResponse.parse(toApiVideo(video)));
});

// GET /videos/stats
router.get("/videos/stats", async (_req, res): Promise<void> => {
  const [row] = await db
    .select({
      totalCount: count(),
      totalSizeBytes: sum(videosTable.size),
      totalDurationSeconds: sum(videosTable.duration),
    })
    .from(videosTable);

  res.json(
    GetVideoStatsResponse.parse({
      totalCount: row?.totalCount ?? 0,
      totalSizeBytes: Number(row?.totalSizeBytes ?? 0),
      totalDurationSeconds: Number(row?.totalDurationSeconds ?? 0),
    }),
  );
});

// GET /videos/:id/stream
router.get("/videos/:id/stream", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, rawId));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  if (!canAccess(video, tokenFromQuery(req.query))) {
    // 404 rather than 403 - a wrong or missing token should not confirm that a
    // recording with this id exists.
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, video.filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Video file not found on disk" });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;
  // Recomputed on every read so rows stored with a mangled type still play.
  const contentType = resolveVideoMime(video.mimeType, video.filename);

  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
    if (!rangeMatch) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }
    const start = parseInt(rangeMatch[1], 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;

    if (
      isNaN(start) ||
      isNaN(end) ||
      start > end ||
      start >= fileSize ||
      end >= fileSize
    ) {
      res.status(416).set("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// POST /videos/:id/share-token
router.post("/videos/:id/share-token", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .update(videosTable)
    .set({ shareToken: newShareToken() })
    .where(eq(videosTable.id, rawId))
    .returning();

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  res.json(GetVideoResponse.parse(toApiVideo(video)));
});

// POST /videos/:id/dropbox
router.post("/videos/:id/dropbox", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!dropbox.isConfigured()) {
    res.status(409).json({ error: "Dropbox is not configured. See .env.example." });
    return;
  }

  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, rawId));
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, video.filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Video file not found on disk" });
    return;
  }

  const targetPath = dropboxPathFor(video, dropbox.dropboxFolder());

  try {
    const uploaded = await dropbox.uploadFile(filePath, targetPath);

    // If this recording is shareable, give it a Dropbox link too.
    let sharedUrl: string | null = null;
    if (wantsDropboxLink(video.visibility)) {
      sharedUrl = await dropbox.createSharedLink(uploaded.path_lower);
    }

    const [updated] = await db
      .update(videosTable)
      .set({
        dropboxPath: uploaded.path_lower,
        dropboxSharedUrl: sharedUrl,
        dropboxUploadedAt: new Date(),
      })
      .where(eq(videosTable.id, video.id))
      .returning();

    res.json(GetVideoResponse.parse(toApiVideo(updated)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dropbox upload failed";
    logger.error({ err, videoId: video.id }, "Dropbox upload failed");
    res.status(409).json({ error: message });
  }
});

// DELETE /videos/:id/dropbox
router.delete("/videos/:id/dropbox", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, rawId));
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  if (!video.dropboxPath) {
    res.json(GetVideoResponse.parse(toApiVideo(video)));
    return;
  }

  if (!dropbox.isConfigured()) {
    res.status(409).json({ error: "Dropbox is not configured. See .env.example." });
    return;
  }

  try {
    if (video.dropboxSharedUrl) await dropbox.revokeSharedLink(video.dropboxSharedUrl);
    await dropbox.deleteFile(video.dropboxPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dropbox delete failed";
    logger.error({ err, videoId: video.id }, "Dropbox delete failed");
    res.status(409).json({ error: message });
    return;
  }

  const [updated] = await db
    .update(videosTable)
    .set({ dropboxPath: null, dropboxSharedUrl: null, dropboxUploadedAt: null })
    .where(eq(videosTable.id, video.id))
    .returning();

  res.json(GetVideoResponse.parse(toApiVideo(updated)));
});

// GET /videos/:id
router.get("/videos/:id", async (req, res): Promise<void> => {
  const params = GetVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, params.data.id));

  if (!video || !canAccess(video, tokenFromQuery(req.query))) {
    // Same 404-for-everything rule as the stream route: a bare /watch link to a
    // non-public recording must not reveal that it exists.
    res.status(404).json({ error: "Video not found" });
    return;
  }

  res.json(GetVideoResponse.parse(toApiVideo(video)));
});

// PATCH /videos/:id
router.patch("/videos/:id", async (req, res): Promise<void> => {
  const params = UpdateVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateVideoBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const changes: Partial<typeof videosTable.$inferInsert> = {};
  if (body.data.title !== undefined) changes.title = body.data.title;

  const nextVisibility = body.data.visibility;
  if (nextVisibility !== undefined && nextVisibility !== existing.visibility) {
    changes.visibility = nextVisibility;
    // Going private has to actually break links that are already out there.
    if (nextVisibility === "private") changes.shareToken = newShareToken();

    const dropboxChanges = await syncDropboxLink(existing, nextVisibility);
    Object.assign(changes, dropboxChanges);
  }

  const [video] = await db
    .update(videosTable)
    .set(changes)
    .where(eq(videosTable.id, params.data.id))
    .returning();

  res.json(UpdateVideoResponse.parse(toApiVideo(video)));
});

// DELETE /videos/:id
router.delete("/videos/:id", async (req, res): Promise<void> => {
  const params = DeleteVideoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [video] = await db
    .delete(videosTable)
    .where(eq(videosTable.id, params.data.id))
    .returning();

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, video.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Best-effort: the row is already gone, so a Dropbox failure must not 500.
  if (video.dropboxPath && dropbox.isConfigured()) {
    try {
      if (video.dropboxSharedUrl) await dropbox.revokeSharedLink(video.dropboxSharedUrl);
      await dropbox.deleteFile(video.dropboxPath);
    } catch (err) {
      logger.warn({ err, videoId: video.id }, "Could not remove the Dropbox copy");
    }
  }

  res.status(204).send();
});

/**
 * Brings the Dropbox shared link in line with a new visibility.
 * Best-effort by design: a Dropbox outage should never block a local
 * visibility change, so failures are logged and the local state still moves.
 */
async function syncDropboxLink(
  video: VideoRow,
  nextVisibility: VideoVisibility,
): Promise<Partial<typeof videosTable.$inferInsert>> {
  if (!video.dropboxPath || !dropbox.isConfigured()) return {};

  try {
    if (wantsDropboxLink(nextVisibility)) {
      const url = await dropbox.createSharedLink(video.dropboxPath);
      return { dropboxSharedUrl: url };
    }
    if (video.dropboxSharedUrl) {
      await dropbox.revokeSharedLink(video.dropboxSharedUrl);
    }
    return { dropboxSharedUrl: null };
  } catch (err) {
    logger.warn({ err, videoId: video.id }, "Could not sync the Dropbox shared link");
    return {};
  }
}

function isVisibility(value: string): value is VideoVisibility {
  return (VIDEO_VISIBILITIES as readonly string[]).includes(value);
}

// Serialize DB row -> API shape
function toApiVideo(v: VideoRow) {
  return {
    id: v.id,
    title: v.title,
    filename: v.filename,
    mimeType: v.mimeType,
    size: v.size,
    duration: v.duration ?? null,
    createdAt: v.createdAt.toISOString(),
    visibility: v.visibility,
    shareToken: v.shareToken,
    dropboxPath: v.dropboxPath ?? null,
    dropboxSharedUrl: v.dropboxSharedUrl ?? null,
    dropboxUploadedAt: v.dropboxUploadedAt ? v.dropboxUploadedAt.toISOString() : null,
  };
}

export default router;
