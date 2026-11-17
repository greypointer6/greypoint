/**
 * Minimal Dropbox client that mints short-lived direct-download URLs.
 *
 * Auth uses an offline refresh token (see scripts/dropbox-refresh-token.mjs):
 * the short-lived access token is cached in memory and refreshed when it is
 * within 60s of expiry. Temporary links are unguessable and expire after a
 * few hours, so a leaked link stops working quickly. `fetchImpl` and `now`
 * are injectable for testing.
 */
export function createDropboxClient({ appKey, appSecret, refreshToken, fetchImpl = fetch, now = Date.now }) {
  let cached = { token: null, expiresAt: 0 };

  async function requestJson(url, options) {
    const res = await fetchImpl(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Dropbox ${res.status} from ${url}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  async function getAccessToken() {
    if (cached.token && now() < cached.expiresAt - 60_000) return cached.token;

    const json = await requestJson("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: appKey,
        client_secret: appSecret,
      }),
    });

    cached = { token: json.access_token, expiresAt: now() + json.expires_in * 1000 };
    return cached.token;
  }

  async function rpc(endpoint, args) {
    const token = await getAccessToken();
    return requestJson(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  return {
    /** Direct-download URL for `path`, valid for a few hours. */
    async getTemporaryLink(path) {
      const json = await rpc("files/get_temporary_link", { path });
      return json.link;
    },

    /**
     * Server-side copy of `fromPath` to `toPath` -- the destination path carries
     * the new file name, so this copies and renames in one call without
     * uploading or modifying the original. This is what lets each download hand
     * the visitor a different file name: Dropbox serves the download itself and
     * names the saved file after the stored file name, so we store a copy of the
     * installer under the per-download name. Requires the files.content.write
     * scope (as does deleteFile).
     */
    async copyFile(fromPath, toPath) {
      return rpc("files/copy_v2", { from_path: fromPath, to_path: toPath, autorename: false });
    },

    /** Remove a file or folder. Used to clean up the per-download copies. */
    async deleteFile(path) {
      return rpc("files/delete_v2", { path });
    },

    /**
     * Entries of a folder, following pagination. Returns [] for an empty folder;
     * throws (like every other call) on auth or scope errors.
     */
    async listFolder(path = "/") {
      const entries = [];
      let cursor = null;
      do {
        const json = cursor
          ? await rpc("files/list_folder/continue", { cursor })
          : await rpc("files/list_folder", { path, recursive: false, limit: 1000 });
        entries.push(...json.entries);
        cursor = json.has_more ? json.cursor : null;
      } while (cursor);
      return entries;
    },

    /** Metadata check used at startup to fail fast on wrong path/credentials. */
    async verifyFile(path) {
      return rpc("files/get_metadata", { path });
    },
  };
}
