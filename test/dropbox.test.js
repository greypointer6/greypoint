import { test } from "node:test";
import assert from "node:assert/strict";
import { createDropboxClient } from "../lib/dropbox.js";

const TOKEN_ENDPOINT = "https://api.dropbox.com/oauth2/token";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const handler = routes[String(url)];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  };
  return { fetchImpl, calls };
}

function tokenRoute(body = { access_token: "tok", expires_in: 14400 }) {
  return () => jsonResponse(200, body);
}

test("caches the access token across temporary-link requests", async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = makeFetch({
    [TOKEN_ENDPOINT]: tokenRoute(),
    "https://api.dropboxapi.com/2/files/get_temporary_link": () => jsonResponse(200, { link: "https://dl.example/f" }),
  });
  const client = createDropboxClient({ appKey: "k", appSecret: "s", refreshToken: "r", fetchImpl, now: () => clock });

  await client.getTemporaryLink("/f.msi");
  await client.getTemporaryLink("/f.msi");

  assert.equal(calls.filter((u) => u === TOKEN_ENDPOINT).length, 1, "token endpoint hit exactly once");
  assert.equal(calls.filter((u) => u.endsWith("get_temporary_link")).length, 2);
});

test("refreshes again when the cached token is inside the 60s expiry margin", async () => {
  let clock = 1_000_000;
  let tokenCalls = 0;
  const { fetchImpl } = makeFetch({
    [TOKEN_ENDPOINT]: () => { tokenCalls++; return jsonResponse(200, { access_token: "tok", expires_in: 14400 }); },
    "https://api.dropboxapi.com/2/files/get_temporary_link": () => jsonResponse(200, { link: "https://dl.example/f" }),
  });
  const client = createDropboxClient({ appKey: "k", appSecret: "s", refreshToken: "r", fetchImpl, now: () => clock });

  await client.getTemporaryLink("/f.msi");
  clock += 14400 * 1000 - 30_000;
  await client.getTemporaryLink("/f.msi");

  assert.equal(tokenCalls, 2);
});

test("getTemporaryLink returns the link and sends bearer token + path", async () => {
  const seen = [];
  const { fetchImpl } = makeFetch({
    [TOKEN_ENDPOINT]: tokenRoute(),
    "https://api.dropboxapi.com/2/files/get_temporary_link": () => jsonResponse(200, { link: "https://uc1.dl.dropboxusercontent.com/x.msi" }),
  });
  const wrappedFetch = async (url, options) => {
    seen.push({ url: String(url), options });
    return fetchImpl(url);
  };
  const client = createDropboxClient({ appKey: "k", appSecret: "s", refreshToken: "r", fetchImpl: wrappedFetch });

  const link = await client.getTemporaryLink("/payload.msi");
  assert.equal(link, "https://uc1.dl.dropboxusercontent.com/x.msi");

  const linkCall = seen.find((c) => c.url.endsWith("get_temporary_link"));
  assert.equal(linkCall.options.headers.Authorization, "Bearer tok");
  assert.equal(JSON.parse(linkCall.options.body).path, "/payload.msi");

  const tokenCall = seen.find((c) => c.url === TOKEN_ENDPOINT);
  assert.equal(String(tokenCall.options.body.get("refresh_token")), "r", "refresh token sent on the OAuth call");
});

test("surfaces API errors (wrong path -> 409) as exceptions", async () => {
  const { fetchImpl } = makeFetch({
    [TOKEN_ENDPOINT]: tokenRoute(),
    "https://api.dropboxapi.com/2/files/get_temporary_link": () =>
      jsonResponse(409, { error_summary: "path/not_found/." }),
  });
  const client = createDropboxClient({ appKey: "k", appSecret: "s", refreshToken: "r", fetchImpl });

  await assert.rejects(() => client.getTemporaryLink("/nope.msi"), /409.*path\/not_found/);
});

test("verifyFile resolves with metadata for an existing file", async () => {
  const { fetchImpl } = makeFetch({
    [TOKEN_ENDPOINT]: tokenRoute(),
    "https://api.dropboxapi.com/2/files/get_metadata": () =>
      jsonResponse(200, { name: "x.msi", size: 9113600 }),
  });
  const client = createDropboxClient({ appKey: "k", appSecret: "s", refreshToken: "r", fetchImpl });

  const meta = await client.verifyFile("/x.msi");
  assert.equal(meta.name, "x.msi");
  assert.equal(meta.size, 9113600);
});
