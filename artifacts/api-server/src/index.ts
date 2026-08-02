// Must come first: importing `app` pulls in @workspace/db, which reads
// DATABASE_URL at module-evaluation time.
import { loadedEnvFile } from "./lib/env";

import app from "./app";
import { logger } from "./lib/logger";

const port = Number(process.env["PORT"] ?? 8080);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, envFile: loadedEnvFile }, "Server listening");
});
