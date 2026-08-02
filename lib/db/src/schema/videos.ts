import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * How a recording may be reached.
 *
 *   private  - the share token is rotated on every switch to private, so any
 *              link handed out previously stops working immediately.
 *   unlisted - playable by anyone holding the token ("anyone with the link").
 *   public   - playable by anyone who knows the id; no token needed.
 */
export const VIDEO_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type VideoVisibility = (typeof VIDEO_VISIBILITIES)[number];

export const videosTable = pgTable("videos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filename: text("filename").notNull().unique(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(), // bytes
  duration: real("duration"), // seconds, nullable
  createdAt: timestamp("created_at").notNull().defaultNow(),

  visibility: text("visibility").notNull().default("private"),
  /**
   * Secret required to stream anything that is not public. The volatile SQL
   * default backfills a distinct value per existing row when this column is
   * added, so recordings made before visibility existed stay playable.
   */
  shareToken: text("share_token")
    .notNull()
    .default(sql`replace(gen_random_uuid()::text, '-', '')`),

  /** Path inside the configured Dropbox folder, once mirrored. */
  dropboxPath: text("dropbox_path"),
  /** Dropbox shared link, present while visibility allows one. */
  dropboxSharedUrl: text("dropbox_shared_url"),
  dropboxUploadedAt: timestamp("dropbox_uploaded_at"),
});

export const insertVideoSchema = createInsertSchema(videosTable).omit({
  createdAt: true,
});

export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type Video = typeof videosTable.$inferSelect;
