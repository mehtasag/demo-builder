import { Router, type IRouter } from "express";

import { GetDropboxStatusResponse, ListDropboxFilesResponse } from "@workspace/api-zod";

import * as dropbox from "../lib/dropbox";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * GET /dropbox/status
 *
 * `configured` reports whether credentials exist; `connected` reports whether
 * they actually work. Keeping them separate lets the UI tell "you haven't set
 * this up" apart from "your token expired", which are very different fixes.
 */
router.get("/dropbox/status", async (_req, res): Promise<void> => {
  const folder = dropbox.dropboxFolder();

  if (!dropbox.isConfigured()) {
    res.json(
      GetDropboxStatusResponse.parse({
        configured: false,
        connected: false,
        folder,
        accountEmail: null,
        error: null,
      }),
    );
    return;
  }

  try {
    const account = await dropbox.getCurrentAccount();
    res.json(
      GetDropboxStatusResponse.parse({
        configured: true,
        connected: true,
        folder,
        accountEmail: account.email,
        error: null,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not reach Dropbox";
    logger.warn({ err }, "Dropbox status check failed");
    res.json(
      GetDropboxStatusResponse.parse({
        configured: true,
        connected: false,
        folder,
        accountEmail: null,
        error: message,
      }),
    );
  }
});

/**
 * GET /dropbox/files
 *
 * Returns 200 with an `error` field rather than a failure status: the combined
 * library view merges this with local recordings, and a Dropbox problem should
 * degrade that page to "local only", not blank it.
 */
router.get("/dropbox/files", async (_req, res): Promise<void> => {
  if (!dropbox.isConfigured()) {
    res.json(
      ListDropboxFilesResponse.parse({
        files: [],
        error: "Dropbox is not configured. See .env.example.",
      }),
    );
    return;
  }

  try {
    const files = await dropbox.listVideos();
    res.json(ListDropboxFilesResponse.parse({ files, error: null }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list Dropbox files";
    logger.warn({ err }, "Dropbox listing failed");
    res.json(ListDropboxFilesResponse.parse({ files: [], error: message }));
  }
});

export default router;
