import fs from "fs";
import path from "path";

/**
 * Loads .env before anything reads process.env. Import this first in the
 * entrypoint: @workspace/db throws at import time without DATABASE_URL.
 *
 * The server runs from artifacts/api-server but .env sits at the workspace
 * root, so walk up to find it. Real env vars win; loadEnvFile does not
 * overwrite what is already set.
 */
function loadEnvFile(): string | null {
  let dir = process.cwd();

  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return candidate;
      } catch {
        // A malformed .env should not stop the server from booting on real env vars.
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const loadedEnvFile = loadEnvFile();
