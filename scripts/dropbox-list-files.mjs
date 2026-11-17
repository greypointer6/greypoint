#!/usr/bin/env node
/**
 * Lists every file the Dropbox app can see, with the exact path to use in
 * DOWNLOAD_FILE_PATH. Run:  node scripts/dropbox-list-files.mjs
 *
 * Requires DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN in .env.
 */
import "dotenv/config";

const appKey = process.env.DROPBOX_APP_KEY;
const appSecret = process.env.DROPBOX_APP_SECRET;
const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

if (!appKey || !appSecret || !refreshToken) {
  console.error("Missing DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN in .env");
  process.exit(1);
}

const tokenRes = await fetch("https://api.dropbox.com/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appKey,
    client_secret: appSecret,
  }),
});
const tokenJson = await tokenRes.json();
if (!tokenRes.ok) {
  console.error(`Token refresh failed (${tokenRes.status}): ${tokenJson.error_description || JSON.stringify(tokenJson)}`);
  process.exit(1);
}

const entries = [];
let cursor = null;
do {
  const res = await fetch(
    cursor
      ? "https://api.dropboxapi.com/2/files/list_folder/continue"
      : "https://api.dropboxapi.com/2/files/list_folder",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cursor ? { cursor } : { path: "", recursive: true, limit: 100 }),
    }
  );
  const json = await res.json();
  if (!res.ok) {
    console.error(`list_folder failed (${res.status}): ${JSON.stringify(json)}`);
    process.exit(1);
  }
  entries.push(...json.entries);
  cursor = json.has_more ? json.cursor : null;
} while (cursor);

if (entries.length === 0) {
  console.log("The app can see no files. Upload the installer into the app folder");
  console.log("(Dropbox/Apps/<AppName>/) — for App-folder apps that folder is the root (\"\").");
  process.exit(0);
}

console.log("Files the app can see (DOWNLOAD_FILE_PATH = path exactly as shown):\n");
for (const entry of entries) {
  console.log(`  ${entry[".tag"].padEnd(4)} ${entry.path_display}`);
}
console.log('\nTip: DOWNLOAD_FILE_PATH must match a "file" path above exactly (case-sensitive).');
