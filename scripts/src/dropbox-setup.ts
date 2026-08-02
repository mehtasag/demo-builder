/**
 * Interactive Dropbox setup.
 *
 * Dropbox has no static API-key auth: every data call needs an OAuth bearer
 * token. The App Console's "generated access token" is one paste but expires in
 * about four hours, so the only durable setup is app key + secret + refresh
 * token. That normally means a browser visit plus a hand-written curl; this
 * script does both and writes the result into .env.
 *
 *   pnpm dropbox:setup
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_PATH = path.join(ROOT, ".env");
const EXAMPLE_PATH = path.join(ROOT, ".env.example");

const API_BASE = process.env.DROPBOX_API_BASE ?? "https://api.dropboxapi.com";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Parses a .env file into ordered lines plus a key index. */
function readEnvFile(file: string): { lines: string[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  if (!fs.existsSync(file)) return { lines: [], values };

  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return { lines, values };
}

/**
 * Sets keys in .env, replacing existing assignments in place and appending the
 * rest. Comments and unrelated variables are preserved - this file usually has
 * DATABASE_URL in it too.
 */
function writeEnvFile(file: string, updates: Record<string, string>): void {
  const { lines } = readEnvFile(file);
  const remaining = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  if (remaining.size > 0) {
    if (next.length > 0 && next[next.length - 1].trim() !== "") next.push("");
    for (const [key, value] of remaining) next.push(`${key}=${value}`);
    next.push("");
  }

  fs.writeFileSync(file, next.join("\n"), { mode: 0o600 });
  // Tighten permissions even if the file already existed.
  fs.chmodSync(file, 0o600);
}

function mask(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}...${secret.slice(-4)} (${secret.length} chars)`;
}

async function main(): Promise<void> {
  // OAuth needs a browser round-trip, so this is interactive by nature. Without
  // a TTY, readline can drop piped lines and then block forever on a prompt that
  // will never be answered - fail loudly instead.
  if (!process.stdin.isTTY) {
    console.error(
      red("This script needs an interactive terminal.") +
        "\n\nRun it directly:\n  pnpm dropbox:setup\n\n" +
        "If you are automating, set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and\n" +
        "DROPBOX_REFRESH_TOKEN in .env yourself - see .env.example.",
    );
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // If the terminal goes away mid-prompt, exit rather than hang on a pending await.
  rl.once("close", () => {
    if (process.exitCode === undefined) process.exitCode = 130;
  });

  try {
    console.log(bold("\nDropbox setup\n"));

    if (!fs.existsSync(ENV_PATH) && fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);
      fs.chmodSync(ENV_PATH, 0o600);
      console.log(dim(`Created .env from .env.example`));
    }

    const { values } = readEnvFile(ENV_PATH);

    console.log(
      "Create an app at " +
        bold("https://www.dropbox.com/developers/apps") +
        "\n  · Scoped access -> App folder (safest)" +
        "\n\n  · Permissions tab - enable these five, then click " +
        bold("Submit") +
        ":\n      account_info.read   files.content.write   files.metadata.read" +
        "\n      sharing.write       sharing.read" +
        "\n    " +
        dim("Do this before generating credentials, or calls fail with missing_scope.") +
        "\n\n  · Settings tab - copy the App key and App secret below\n",
    );

    const appKey =
      (
        await rl.question(`App key ${dim(values.get("DROPBOX_APP_KEY") ?? "")}: `)
      ).trim() ||
      values.get("DROPBOX_APP_KEY") ||
      "";
    const appSecret =
      (
        await rl.question(
          `App secret ${dim(values.get("DROPBOX_APP_SECRET") ? "(keep existing)" : "")}: `,
        )
      ).trim() ||
      values.get("DROPBOX_APP_SECRET") ||
      "";

    if (!appKey || !appSecret) {
      console.error(red("\nBoth an app key and an app secret are required."));
      process.exitCode = 1;
      return;
    }

    // token_access_type=offline is what makes Dropbox return a refresh token;
    // without it you only get a 4-hour access token.
    const authorizeUrl =
      `https://www.dropbox.com/oauth2/authorize` +
      `?client_id=${encodeURIComponent(appKey)}` +
      `&response_type=code&token_access_type=offline`;

    console.log(`\n${bold("1.")} Open this URL and click Allow:\n\n   ${authorizeUrl}\n`);
    console.log(`${bold("2.")} Dropbox shows an access code. Paste it below.`);
    console.log(dim("   The code is single-use and expires within minutes.\n"));

    const code = (await rl.question("Access code: ")).trim();
    if (!code) {
      console.error(red("\nNo code entered."));
      process.exitCode = 1;
      return;
    }

    process.stdout.write("\nExchanging code for a refresh token... ");

    const auth = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
    const response = await fetch(`${API_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code }),
    });

    if (!response.ok) {
      console.log(red("failed"));
      console.error(`\n${red(await response.text())}`);
      console.error(
        "\nCommon causes: the code was already used, it expired, or the app key" +
          "\nand secret do not match the app the code came from. Re-run to retry.",
      );
      process.exitCode = 1;
      return;
    }

    const token = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
    };

    if (!token.refresh_token) {
      console.log(red("no refresh token returned"));
      console.error(
        "\nThe authorize URL must include token_access_type=offline." +
          "\nRe-run this script rather than reusing an older URL.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(green("done"));

    // Prove the credentials work before writing them.
    process.stdout.write("Verifying against Dropbox... ");
    const account = await fetch(`${API_BASE}/2/users/get_current_account`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });

    if (!account.ok) {
      console.log(red("failed"));
      console.error(`\n${red(await account.text())}`);
      console.error(
        "\nCheck that the permissions listed above are enabled and submitted.",
      );
      process.exitCode = 1;
      return;
    }

    const profile = (await account.json()) as {
      email?: string;
      name?: { display_name?: string };
    };
    console.log(
      green(`connected as ${profile.email ?? profile.name?.display_name ?? "unknown"}`),
    );

    writeEnvFile(ENV_PATH, {
      DROPBOX_APP_KEY: appKey,
      DROPBOX_APP_SECRET: appSecret,
      DROPBOX_REFRESH_TOKEN: token.refresh_token,
      // A stale short-lived token would otherwise sit unused and confuse things.
      DROPBOX_ACCESS_TOKEN: "",
    });

    console.log(`\nWrote to ${bold(".env")} (chmod 600):`);
    console.log(`  DROPBOX_APP_KEY=${appKey}`);
    console.log(`  DROPBOX_APP_SECRET=${mask(appSecret)}`);
    console.log(`  DROPBOX_REFRESH_TOKEN=${mask(token.refresh_token)}`);
    console.log(
      `\n${green("Done.")} Restart the API server and the Dropbox panel will show as connected.`,
    );
    console.log(
      dim("This refresh token does not expire; access tokens are minted from it.\n"),
    );

    // Mark success explicitly. Otherwise the rl "close" handler below, which
    // fires from the finally block, sees an undefined exit code and treats this
    // as an interrupted run - reporting exit 130 even though everything worked.
    process.exitCode = 0;
  } finally {
    rl.close();
  }
}

await main();
