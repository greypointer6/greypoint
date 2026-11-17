#!/usr/bin/env node
/**
 * One-off helper: exchange a Dropbox authorization code for the long-lived
 * refresh token that server.js needs. Run once after creating the app:
 *
 *   node scripts/dropbox-refresh-token.mjs
 *
 * Requires DROPBOX_APP_KEY and DROPBOX_APP_SECRET in .env (see README).
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";

const appKey = process.env.DROPBOX_APP_KEY;
const appSecret = process.env.DROPBOX_APP_SECRET;

if (!appKey || !appSecret) {
  console.error("Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET in .env first (see the README).");
  process.exit(1);
}

const authorizeUrl =
  `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(appKey)}` +
  "&response_type=code&token_access_type=offline";

console.log("1. Open this URL in a browser and approve access:\n");
console.log(`   ${authorizeUrl}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("2. Paste the authorization code here: ")).trim();
rl.close();

if (!code) {
  console.error("No code entered.");
  process.exit(1);
}

const res = await fetch("https://api.dropbox.com/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appKey,
    client_secret: appSecret,
  }),
});

const json = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Exchange failed (${res.status}): ${json.error_description || JSON.stringify(json)}`);
  process.exit(1);
}

console.log("\n3. Add this to .env — it does not expire:\n");
console.log(`DROPBOX_REFRESH_TOKEN=${json.refresh_token}\n`);
