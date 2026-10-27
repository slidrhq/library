# Slidr Library — implementation plan

Status: **approved 2026-10-25**; P1–P8 are done and on `main`, and P9 waits on the user. **Revised and approved 2026-10-26:** P10–P13 make a local library a Docker image with Nginx inside, installed by a script on Linux, with its media in a folder of that machine, and take away what P7 and P8 added for other stores ([specification](SPEC.md), R1, R5, R6, D12–D17). They come before what is left of P9. On 2026-10-26, P10–P12 were built on the branch `local-docker`, and `image.yml` passes on both architectures; what waits on the user is the install by hand of P12, the first release (P13), and merging. Section numbers such as §9.4 are the specification's.

## Order

```text
P1 core and ports ──► P2 Node host, vault, CLI ──┬──► P3 people and sign-in ──► P4 tokens ──┐
                                                 └──► P5 media stores: folder ──────────────┴──► P6 approval publishes ──┬──► P7 SFTP, FTP
                                                                                                                         └──► P8 Cloudflare from a machine
                                                                                                         (P1–P8 done, on main)

P10 the local host narrowed ──► P11 the image ──► P12 the install script ──► P13 releasing ──► P9 moving over and docs (last)
```

The central library (the Cloudflare host) changes in none of P10–P13. A local library that installs and works end to end is **P10 to P12**, from an image built on the branch. P13 publishes it.

## How the work is done

- P10–P13 are on the branch `local-docker`, in the worktree `.claude/worktrees/local-docker`. Other sessions work in this repository's `main` at the same time. The branch is rebased onto `main` at the start of each phase and before each merge. Nothing is stashed or reset in the main checkout.
- **A push to `main` deploys the central library** (`.github/workflows/deploy.yml`, https://library.slidr.workers.dev). A phase is merged only when the Worker behaves as it did, with the secrets it has: its tests pass unchanged, and `pnpm dev` runs as before. Merging and pushing are done only when the user asks.
- **This machine has no Docker** (Windows, with no WSL). The image and the script are built and tested on GitHub's Ubuntu runners, `ubuntu-24.04` (x86-64) and `ubuntu-24.04-arm` (ARM64), by a workflow that runs on the branch (`image.yml`) and builds no release. The last check of P12 is an install by hand on a Linux machine of the user's.
- A phase is done when:
  - `pnpm check` and `pnpm test` pass, and from P11 on, `image.yml` passes on both runners;
  - its acceptance holds;
  - its pages have been looked at in Hebrew and in English, and what that showed has been fixed.

## P1. Core and ports, with no change in behaviour — done

The core is moved out of the Worker so a second host can run it.

- Move `worker/` to `server/`:
  - routes, auth, uploads and media go to `server/core/`;
  - today's `index.ts` becomes `server/host/cloudflare/index.ts`, and `node.mjs` moves to `server/node.mjs`;
  - update `wrangler.jsonc` (`main`), both `tsconfig`s, `eslint.config.js`, the scripts of `package.json`, `.prettierignore`, and `.github/workflows/deploy.yml`;
- A `Context` handed to every route: `{ store, media, config, clientAddress, waitUntil, now }`. Nothing in `server/core` reads `env` any more. The Cloudflare host builds the context from `env`, as the routes read it today: `UPLOADS`, `MEDIA`, `MEDIA_LIBRARY_URL`, the secrets.
- Two ports:
  - `StateStore` is today's `Bucket` (`uploads/store.ts`), named for what it is;
  - `MediaStore` is the part of `Bucket` that `media/*.ts` uses (§4.5).

  For now both are R2 on Cloudflare. A folder `StateStore` (`server/host/node/state.ts`, §4.3) and memory stores for the tests come in this phase too.

- **Tests:**
  - every test of `api.test.ts`, `auth.test.ts`, `media.test.ts` and `site.test.ts` passes as before;
  - the folder store and the bucket in memory of the tests are held to one contract (`server/host/node/state.test.ts`): objects and their metadata, a conditional put that loses, listing in order and by page, keys a file system would refuse or take for one another (`:`, `*`, `con`, a final dot, capitals), deleting;
  - an upload is made, read, listed, rejected and withdrawn through the server over a folder store;
  - the core imports nothing of Node (`no-restricted-imports` in `eslint.config.js`).
- **Acceptance:** `pnpm dev` and a deployment on Cloudflare behave exactly as before.

## P2. The Node host, the vault and the CLI — done

- `server/host/node/main.ts`:
  - `node:http`, which turns Node's requests into web `Request`s and back;
  - it serves `dist/client` (with the page's fallback for addresses it does not know), `/auth/*`, `/api/*` and `/media/*`;
  - it listens on `127.0.0.1:5176`. `--host` is accepted only with `--tls-cert`/`--tls-key` or with `--behind-proxy`, which trusts `X-Forwarded-Proto`/`-Host`. The library's own URL comes from its settings;
  - it runs from its source, as the tests do: Node strips the types, and `server/node.mjs` resolves the imports of `vendor/` as a bundler would. A bundle can come later if starting it is slow.
- `server/core/vault.ts` (§4.4): AES-256-GCM through `crypto.subtle`, the additional data `slidr-library:vault:<name>`, and `kid`. The master key comes from one of:
  - the OS keychain, through `@napi-rs/keyring` (first check that it ships prebuilt binaries for win32-x64, win32-arm64, darwin and linux-gnu);
  - `LIBRARY_MASTER_KEY`;
  - `--master-key-file`.
- `server/core/config.ts`: the schema of `config/library.json` in zod (§5.3).
- The CLI (`server/host/node/cli.ts`, run as `pnpm library <command>`): `init`, `start`, `login`, `media test`, `media key`, `vault rotate`, `owner`. A key is read from a hidden prompt, or from standard input when it is not a terminal, and never from an option. `init` with every option needs no one at the keyboard.
- The data folder: the default of each OS (§5.1). On Windows its ACL grants the current user only (`icacls /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`), and elsewhere its mode is 0700.
- **Tests:**
  - the vault: a round trip; a byte changed in the IV, the data or the tag; a sealed key moved to another name; the wrong master key; rotation;
  - `init` without anyone at the keyboard, into a temporary folder;
  - the server: it serves the page and `/api/me`.
- **Acceptance (Windows):**
  - `pnpm library init --data <tmp> --owner <email> --media folder --media-path <dir>` followed by `pnpm library start` serves the page;
  - the master key is in Credential Manager;
  - no file of the data folder holds a key in clear (search it for the keys used in the test).

P10 takes the keychain, the Windows ACL and the defaults of Windows and macOS away again.

## P3. People, roles and signing in — done

- `server/core/people.ts`: `people/<email>.json`, the roles of §6.1 and the owner's rules (exactly one, cannot be removed, ownership handed over). Also blocking (§6.3), and roles read from the store on every request.
- `authorize(request, ctx, permission)` is written again around the table of §6.1:
  - permissions: `read-own`, `upload`, `read-all`, `review`, `publish-waiting` (reviewers), `publish-files` (admins: import and an author's files), `members`, `settings` and `owner`;
  - today's `publish` permission of `media/routes.ts` is split between `publish-waiting` and `publish-files`;
  - the scope of a token comes in P4.
- Signing in (`server/core/auth.ts`):
  - OIDC from the discovery document (kept for an hour), with presets for Google and Microsoft;
  - allowed domains;
  - the `session` key from the vault;
  - **Sign everyone out**;
  - `/auth/local?code=` (§6.2), loopback only through `ctx.clientAddress`, and `pnpm library login`.
- On Cloudflare, so that the deployment keeps working (§13):
  - at start, when the store has no owner, `LIBRARY_OWNER` becomes the owner and `LIBRARY_EDITORS` the reviewers;
  - until OIDC is set, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` serve as the Google preset;
  - without `LIBRARY_MASTER_KEY`, `SESSION_SECRET` stays the session key.
- The page: `/api/me` in its new shape, the account button, **Members** (§11), and the first-run message of a local install. Its words go in Hebrew and English, and in `src/i18n/locales/*`.
- **Tests:**
  - a table of every route against every role (anyone, signed in, reviewer, admin, owner, blocked);
  - the owner cannot be removed, and no one changes the owner's role;
  - a role changed, or taken away, takes effect at the next request;
  - allowed domains;
  - the local link: once only, after 10 minutes, and from an address that is not loopback;
  - OIDC from a stand-in discovery document, and today's tests of the ID token kept.

P10 lets the owner's link in from any address (D17).

## P4. Tokens and open uploading — done

- `server/core/tokens.ts` (§7): make a token (`slk_` + 32 bytes base64url), keep its SHA-256 (`tokens/<hash>.json`, `people/<email>/tokens/<id>`), find it by its hash, the scope, expiry, last use (written at most once an hour), revoke, at most 10 a person.
- `authorize`:
  - `Authorization: Bearer` is judged by the token alone: its cookie is ignored, and no `Origin` is asked;
  - it acts as its owner, with its scope checked against the owner's role now. Outside its scope it answers `403 token-scope`;
  - unknown, revoked, expired, or with a blocked owner: the same `401` for every case;
  - `LIBRARY_KEYS` keeps working until P9, as a `publish` scope, with a warning in the log each time it is used.
- Uploads:
  - each records its owner;
  - an uploader lists, reads, changes and withdraws only their own;
  - the limits of §6.4, which hold anyone without a role: waiting uploads and their bytes are counted from the summaries in the store (each keeps its bytes). 429 is counted in the server's memory; on Cloudflare each isolate counts apart, and the Rate Limiting binding can take over if that proves loose.
- The page: **Profile**, with the scope (offered to admins), the token shown once, copy, an example `curl.exe`, the list of tokens, and revoke.
- **Tests:**
  - a request with only `Authorization` (no cookie, no `Origin`) makes an upload;
  - an `upload` token on `POST /api/publish` or on approving answers `403 token-scope`;
  - a `publish` token publishes, and stops when its owner stops being an admin;
  - a token and a cookie together: the token wins;
  - a token revoked, expired, or with a blocked owner: the same 401;
  - each limit;
  - one uploader cannot see another's upload;
  - the app's `media:publish` flow (`staged`, then `files`) passes with a `publish` token.

## P5. Media stores: the folder, the bookkeeping, `/media/` — done

- `server/host/node/media.ts`, `FolderMedia`, the `MediaStore` of a local folder (§4.5):
  - writes go to a hidden name in the same folder, then a rename;
  - every path stays inside the root (`isLibraryPath`, then a check after resolving; a link out of the root leads nowhere);
  - a file's SHA-256 comes from the manifest, or is read once and kept while the file is unchanged; a file's etag is its size and the moment it was written, and one process writes the folder, so put-if-match holds;
  - `testStore` (`settings.ts`) reads the manifest, then writes and removes a hidden probe file.
- The bookkeeping is in the state store already (`main`, 4e2bef5: `media/history/`, `media/staged/`, `media/lock.json`; D11). What remains of it, the lock taken with put-if-match (§4.7), moves to P6: until approving publishes, publications start by hand, and the manifest is written with put-if-match.
- `/media/` is `serve.ts` over `ctx.media`. The page is built with `define: { __SLIDR_MEDIA_PATH__: 'globalThis.__slidrMediaPath' }` in `vite.config.ts`, and the server on a machine sets it to `/media/` in the page it serves; on Cloudflare it stays unset, and the page reads the published site. Check that every reader in `vendor/desktop/src` goes through `mediaUrl`/`mediaBase` and none names the site, and that `src/media.ts` stops naming `MEDIA_LIBRARY_URL`.
- The checks: `libraryFor` reads `ctx.media` once it has a manifest, and the site before that, as today.
- Settings:
  - `GET/PUT /api/settings/*` and `POST /api/settings/media/test` (`server/core/settings.ts`); a store is tried before it is kept, and the server reads the settings again when they change (`contextSource`). `PUT /api/settings/media/key` comes with the first store that has a key (P7);
  - the **Settings** page (§5.3) with the folder;
  - **Seed**, which is today's import over any store, from the CLI (`init --seed`) and from the page.
- D7: take `path` out of upload views, and `bucket` out of `GET /api/library`. First find what the page reads of them (`src/uploadsApi.ts`, `src/Uploads.tsx`, `src/UploadDetail.tsx`), and keep them inside the core (`publish.ts` checks `stored.path`).
- **Tests:**
  - every test of `media.test.ts` runs over the R2 stand-in and over a folder;
  - `/media/`: its headers, 304, 404, `manifest.json` with `no-cache`;
  - a path that climbs out (`..`, `%2e%2e`, `\`, a drive, a link outside the root) is refused;
  - the folder holds no `_…` file after a publication.
- **Acceptance:** `pnpm library start`, over a folder seeded from media.slidr.studio, shows every part as media.slidr.studio shows it.

## P6. Approval publishes — done

- The lease (`media/lock.json`) is taken with put-if-match: two reviewers who approve at once never both write. It stays in the store once made, and is let go by writing it as free, again with put-if-match, so taking it never depends on a file being absent.
- Approving (`setStatus` to `accepted`) checks the upload, saves it, then calls `publish(…, [id])`, and answers the upload together with the publication.
  - When the lease is held, it answers `accepted`, waiting.
  - When the upload no longer holds, it goes back to `pending` with the note (§8).
  - When it cannot be written (`PublishError`, the store unreachable), it stays `accepted` with `publication: { message, at, attempts }`.
- The sweep (§4.7): a timer in the Node process; on Cloudflare a Cron Trigger (`triggers.crons` in `wrangler.jsonc`) and a `scheduled` handler. It tries again after 1, 5 and 30 minutes, then waits for **Try again** (`POST /api/publish` with the upload).
- Putting the media back (§9.4): when the publication fails before the manifest, it puts back each file it replaced, from the history, and removes each it added. It keeps its answer as `media/history/<published>/publication.json` (§9.5). Clearing (§4.7) removes rejected uploads after 30 days and keeps the last 100 publications.
- The page:
  - approving shows the publication that followed;
  - an approved upload that waits shows why, with **Try again**;
  - **Publications** (§11).
- **Tests:**
  - approving publishes it, and the media has it;
  - approving while a publication holds the lease leaves it waiting, and the sweep writes it;
  - an upload that no longer holds goes back to `pending`, and the rest is written;
  - a failure injected after each step of writing leaves the media as it was (the SHA-256 of every file compared, over the folder and over the R2 stand-in);
  - the attempts and their waits;
  - the result is read by the app's own reader (`@slidr/media-library`, every file against its manifest).
- **Acceptance, from start to end on Windows, with a folder:**
  1. `init --seed`, then the link of `login`;
  2. a token from the profile;
  3. `curl.exe` uploads a design with only `Authorization`;
  4. approval in the page;
  5. the picture and `managed.json` are in the folder, the manifest is consistent, `/media/` serves them, and the page shows the design under Designs;
  6. the app, pointed at `http://127.0.0.1:5176/media/` (`media-library.json`, docs/media-library.md), shows it in Ready slides.

## P7. SFTP and FTP (Node only) — done, then taken away by P10

- `server/host/node/media/sftp.ts` with `ssh2`: the host key pinned by its fingerprint, confirmed by an admin; a private key or a password; `posix-rename@openssh.com` where the server has it; the manifest's hash compared before it is written.
- `server/host/node/media/ftp.ts` with `basic-ftp`: explicit FTPS by default, or implicit; plain FTP only when allowed; `RNFR`/`RNTO`, falling back to remove then rename.
- Reads kept in a cache by SHA-256 in the data folder (`remote.ts`).
- **Tests:** a SFTP server (`ssh2`'s `Server`) and an FTP server (`ftp-srv`) inside the tests.

## P8. Cloudflare from a machine (R2) — done, then taken away by P10

- `server/core/media/r2s3.ts`: an R2 bucket through its S3 API, signed with SigV4 by `aws4fetch`, the manifest compared before it is written, and the cache before the bucket's domain emptied with the zone's purge token.
- Settings on Node, for R2: the account ID, the bucket, its domain, the zone's id, the S3 credentials and the purge token.
- **Tests:** the S3 API stood in for, and the tests of `media.test.ts` over it.

## P10. The local host narrowed: Linux, one folder (SPEC D12, D13, D17)

Nothing of the Cloudflare host changes. What goes, goes in commits of its own, so each can be read alone.

- **The stores taken away:**
  - `server/host/node/sftp.ts`, `ftp.ts`, `remote.ts` and their tests, `servers.testing.ts`, and `server/core/media/r2s3.ts` with its test;
  - in `config.ts`, the kinds `sftp`, `ftp` and `r2`, and the media's `kind` itself on Node: the folder is the host's, not a setting (below);
  - in `settings.ts`, choosing a store, the media's key, the host key and its confirmation; `PUT /api/settings/media` and `PUT /api/settings/media/key` go, and `host-key-changed` with them;
  - the vault's `media` key: a sealed `media` key found at start is removed, and the audit says so;
  - in `src/Settings.tsx` and `src/settingsApi.ts`, the choice of store, the fields of each, the key fields and the host key; their words in `src/i18n/areas/settings.ts` and every `src/i18n/locales/*`;
  - the packages `ssh2`, `@types/ssh2`, `basic-ftp`, `ftp-srv` and `aws4fetch`, the entries of `allowBuilds` in `pnpm-workspace.yaml` that only they needed (`ssh2`, `cpu-features`, `dtrace-provider`), and the lockfile;
  - in the README, the stores of a machine, and "An organization's own bucket, from a library on a machine".
- **The master key** (`master.ts`): the keychain goes, with `@napi-rs/keyring`. What stays is a file (the default; `init` writes it 0600, into a folder it makes 0700 when it does not exist) and `LIBRARY_MASTER_KEY` (the tests). `vault rotate` writes `master.key.next` beside the key, seals every key again, then renames it over the old one. `host.json` names the file.
- **The data folder:** the defaults of Windows and macOS, and the Windows ACL (`icacls`), go. The folder is `--data` or `SLIDR_LIBRARY_DATA`, and is made 0700.
- **The media folder is the host's:** `start` and `init` take `--media <dir>` (`LIBRARY_MEDIA` in the image), and `config/library.json` no longer names it. `--media` is refused when it is the data folder or the keys folder, inside either, or holds either (as today's check in `settings.ts`). `GET /api/settings` answers where it is (the path the script named, given to the container as `LIBRARY_MEDIA_SHOWN`, since the container sees only `/library/media`) and the room left on its disk (`statfs`).
- **The URL is the host's:** `start --url` (`LIBRARY_URL` in the image), shown and not changed in Settings, and `PUT /api/settings/library` goes. On Cloudflare it was already the Worker's own, and the route answered `409 host` there.
- **The owner's link from any address** on the Node host (D17): `/auth/local` no longer asks `fromThisMachine`. `fromThisMachine` stays for trusting `X-Forwarded-*`.
- **The CLI** (`cli.ts`): `init`, `start`, `login`, `seed`, `sign-in`, `owner`, `vault rotate`, `status`. `owner <email>` hands ownership over from the machine (§6.1), and `status` prints the store's **Test** and the room left, for `slidr-library status`. Its usage and the README say it is what the image runs, and that a run from the source is for working on the code.
- **The page:** Settings → Media shows where the media is (the bucket, or the folder and its room), **Test**, **Seed** and the public URL, and nothing to choose. The first-run message names `slidr-library login`.
- **Tests:**
  - every test of a removed store goes; the folder's stay, and `media.test.ts` runs over the R2 stand-in and the folder as before;
  - `settings.test.ts`: no media can be put; the folder and its room are answered; the URL cannot be put on Node and can on Cloudflare;
  - the vault: a rotation over a file, and one stopped half way (the `.next` file left) that opens under either key;
  - the owner's link from an address that is not loopback signs in, once, and not after 10 minutes;
  - a sealed `media` key is removed at start;
  - `pnpm install --frozen-lockfile` in CI with no build scripts left to allow.
- **Acceptance:** the Worker's tests pass unchanged, and `pnpm dev` behaves as before. On this machine, a run from the source (`pnpm library init`, then `start`, with `LIBRARY_MASTER_KEY` and folders of a temporary folder) shows Settings in Hebrew and English with the folder only.

## P11. The image (SPEC D14, §4.6, §5.4)

- **The Node host in one file:** `vite.node.config.ts` builds `server/host/node/cli.ts` with Vite's SSR build into `dist/node/library.mjs`, resolving `@desktop/…` and the vendored packages as the page does, with no package left outside it but `node:*`. The image names its page with `LIBRARY_CLIENT`. `bundle.test.ts` builds the bundle into a temporary folder and runs `init`, `start`, `status` and `login` from it. `pnpm build` builds both.
- **`docker/Dockerfile`**, in two stages:
  - build, once for every architecture (`--platform=$BUILDPLATFORM`, since its output is JavaScript): the pnpm of `packageManager`, installed by npm (Corepack of Node 22 may refuse newer pnpm releases' keys), `pnpm install --frozen-lockfile`, `pnpm build`;
  - run: `node:22-trixie-slim`, pinned by digest; `nginx` and `tini` from Debian; the user and group 10001 (`slidr`); `/app/dist/client`, `/app/dist/node/library.mjs`, `/etc/nginx/slidr/`, `slidr-library-entry` and `slidr-library` in `/usr/local/bin`; the folders `/library/{data,media,keys,tls}`; `EXPOSE 8080`; `HEALTHCHECK` (`docker/health.mjs`: `/api/me` through Nginx, over TLS when Nginx speaks it); `ENTRYPOINT ["tini", "-g", "--", "slidr-library-entry"]`, `CMD ["serve"]`; the OCI labels.
- **Nginx** (`docker/nginx.conf`, and its includes):
  - `listen 8080`, with `ssl` and `http2` when `/library/tls/cert.pem` and `key.pem` are there, TLS 1.2 and 1.3 only (the entry writes `/tmp/nginx/listen.conf`);
  - `/media/` as §4.6 (`media.conf`): `alias /library/media/`; 404 for what `isLibraryPath` refuses (a part that begins with `.`, a first `_`, `\`, `:`, `//`, a folder), with `merge_slashes off`; `try_files`, so a folder is 404, not a redirect; `autoindex off`; `disable_symlinks on`, a link answered as missing; the headers (`media-headers.conf`) and the `Cache-Control` of `live.ts`; `Content-Security-Policy: sandbox`; `OPTIONS` 204 and other methods 405 (`media-methods.conf`, included in each location, since an `if` holds for its own); `serve.ts`'s 404 page (`@missing`); `etag on`;
  - `docker/media-types.conf`, written from `MEDIA_TYPES` of `live.ts` by `pnpm nginx-types`; `nginx.test.ts` fails when they part;
  - `/assets/` from `dist/client`, `Cache-Control: public, max-age=31536000, immutable`;
  - everything else to `http://127.0.0.1:5176`, with `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`; in the proxy way, `set_real_ip_from <the proxy>` and `real_ip_header X-Forwarded-For`, and the proxy's `X-Forwarded-Host` kept (`/tmp/nginx/proxy.conf`). Node takes the scheme from `X-Forwarded-Proto` of a proxy of its own machine (`server.ts`);
  - `client_max_body_size 100m`, over the largest request the core takes (an author's file, 95 MiB), and `proxy_request_buffering off`, so an upload is not first written to `/tmp`; `proxy_read_timeout 600s`, since approving and seeding answer when they are done;
  - `server_tokens off`; temporary folders and the pid under `/tmp`; the access log with `$uri`, never `$request` or `$args`, to standard output, and the error log to standard error.
- **`docker/entry.sh`** (bash, `shellcheck`): `serve` writes Nginx's part of the install, starts Node (`start --behind-proxy --port 5176 --url $LIBRARY_URL`), waits up to 30 seconds for `/api/me`, starts Nginx, and ends with the first of the two to end, stopping the other; `init` installs into the folders of `/library/`; every other command goes to the CLI.
- **The compose file** is the install script's (P12): the image by digest; `ports: ["<bind>:<port>:8080"]`; the folders; `LIBRARY_URL`, `LIBRARY_MEDIA_SHOWN`, `LIBRARY_TRUSTED_PROXY`; `read_only: true`; `tmpfs: [/tmp]`; `cap_drop: [ALL]`; `security_opt: [no-new-privileges:true]`; `restart: unless-stopped`; `logging` json-file, 5 × 10 MB. Until then, the tests run the image with the same hardening by `docker run`.
- **`.github/workflows/image.yml`**, on every push, on `ubuntu-24.04` and `ubuntu-24.04-arm`: `shellcheck`, the image built and kept under 300 MB, then `docker/test/image.test.ts` over containers with folders of the runner, the media a library of the fixtures of `uploads/testing.ts`:
  - **parity:** for every file, the manifest, a missing file, a hidden path (`.slidr-library-probe.json`, `a/.git/config`), `_staged/…`, a folder, `a\b`, `a:b`, `a//b`, and a link out of the folder, Nginx's answer has the status, `Content-Type`, `Cache-Control`, CORS headers, `nosniff` and `X-Slidr-Library` that `serveMedia` answers over the same folder (run from the source beside it), the same bytes, and `Content-Security-Policy: sandbox`; `OPTIONS`, `POST`, `HEAD` and `If-None-Match`; nothing out of the folder by `%2e%2e`;
  - **the page:** its HTML sets `__slidrMediaPath` to `/media/`, and `/assets/` are immutable;
  - **end to end:** the owner's link (`docker exec … slidr-library login`); a token made; a design uploaded with the token alone; approved with the session; the picture and `managed.json` in the folder on the runner, served by Nginx, and every file read by `@slidr/media-library`'s reader against the manifest;
  - **the container:** it runs as 10001 with a read-only root; `docker stop` ends it within 10 seconds; Node killed ends the container, and Docker starts it again; its log holds no `code=`; TLS with a certificate made for the test, reached by its name, and the cookie `__Host-` over it.
- **Acceptance:** `image.yml` passes on both runners, and the image is under 300 MB.

## P12. The install script and the command (SPEC D15, D16, §5.1, §5.5)

- **`install/install.sh`** (bash 4 or later, `shellcheck` clean), as §5.5:
  - checks: Linux, x86-64 or ARM64, root, Docker 24 or later (rootful: `docker info` names no `rootless`), `docker compose` v2, `ss`, `findmnt`, `curl`;
  - questions and their options, `--yes`, and the list of what is missing when no one is at the keyboard. It reads answers from `/dev/tty`, so `curl … | sudo bash -s -- …` works as well as a downloaded file;
  - the checks of the answers: a local file system for the media (`findmnt -no FSTYPE -T`; refused: `nfs*`, `cifs`, `smb3`, `fuse.*`, `9p`, `ceph`, `glusterfs`), empty or a library, apart from the data and keys folders, room enough when seeded (the sizes in the source's manifest, and 10% more); the port free (`ss -Hltn "sport = :<port>"`, and `docker ps --format '{{.Ports}}'`); a certificate and its key that match (`openssl`, when present; else Nginx's own check in a one-off container);
  - the summary, then: the folders (`install -d -o 10001 -g 10001`, modes 0700 and 0755), `compose.yaml` (written by the script itself, with the image's hardening of P11), `library.env`; `:Z` under SELinux in enforcing mode (`getenforce`); the note about `ufw` and `firewalld` in the HTTPS and proxy ways;
  - `docker compose pull`, `docker compose run --rm library init …`, the seed with its progress, `docker compose up -d`, a wait for `healthy` (2 minutes at most, then the last lines of the log, and an exit that is not 0);
  - `/usr/local/bin/slidr-library`, then the URL, the owner's link and the apps' address.
- **Run again** (an installed `library.env` found): update to its own version (the default), change how it is reached or the port, or stop. `--update` updates with no questions. Nothing in the data, keys or media folders is written over.
- **The image it installs** is written into the script by the release (P13), as `ghcr.io/slidrhq/library:<version>@sha256:<digest>`. On the branch, `--image <reference>` names another, for the tests.
- **`install/slidr-library`** (bash, `shellcheck`), carried in the image (`/app/host/slidr-library`) and copied out by the script, so it is of the image's version; the command of §5.1: `login`, `status`, `logs`, `stop`, `start`, `restart`, `update [<version>]`, `sign-in`, `owner`, `vault rotate`, `uninstall [--purge]`. Each runs `docker compose -f /etc/slidr-library/compose.yaml …`. `update` downloads `install.sh` and `install.sh.sha256` of that release, checks one against the other, and runs it with `--update`; `update --image` and `change` run the machine's own copy of the script (`/etc/slidr-library/install.sh`). `uninstall --purge` asks for the folders' names to be typed again.
- **Tests** (`install/test/install.test.ts`), in `image.yml` on both runners, over the image built in the job:
  - `shellcheck` of the script, the command and the entry;
  - an install with no one at the keyboard, the way of this machine only, seeded from a server of the fixtures on the runner's own address (`--seed=http://<address>:<port>/`, which the container reaches): healthy, the page, `/media/manifest.json`; then every command: `login`, `status`, `logs`, `stop`, `start`, `update --image` to the same image, `vault rotate` (the library works after it); `uninstall` keeps the folders, and a new install over them finds the same owner and uploads;
  - an install by questions, its answers given through `expect`;
  - the HTTPS way, with a certificate made for the test: `curl --cacert` reaches it, and the cookie is `__Host-`;
  - refused: a taken port, a media folder on a network file system (a `findmnt` stood in for on the `PATH`), a folder holding other files, a media folder inside the data folder, no media folder or owner named, no Docker, not Linux, an architecture not offered, a rootless Docker, a key that is not its certificate's.
- **Acceptance**, by the user on a Linux machine (Ubuntu 24.04 or Debian 13, a VM is enough), with the image of the branch (`git clone -b local-docker`, `docker build -f docker/Dockerfile -t slidr-library:dev .`, then `sudo bash install/install.sh --image slidr-library:dev`), or with the first release:
  1. `sudo bash install.sh`, answering the questions, seeded from media.slidr.studio;
  2. the owner's link it printed, then a token from the profile;
  3. `curl` uploads a design with only `Authorization`;
  4. approval in the page;
  5. the picture and `managed.json` are in the media folder, `<url>/media/` serves them, and the page shows the design under Designs;
  6. the app, pointed at `<url>/media/` (`media-library.json`, docs/media-library.md), shows it in Ready slides.

## P13. Releasing (SPEC §5.4)

- **`.github/workflows/release.yml`**, on a tag `v<version>` (it must match `package.json`), and by hand:
  - `pnpm check` and `pnpm test`;
  - the image built on both runners, natively, and joined into one manifest list; pushed to `ghcr.io/slidrhq/library` as `<version>`, `<major>.<minor>` and `latest`, with an SBOM and provenance (`docker/build-push-action`), and attested (`actions/attest-build-provenance`);
  - the digest written into `install.sh`, and `install.sh.sha256` made;
  - the tests of P12 run again, over the pushed digest, pulled with no login;
  - a GitHub release of the tag, with `install.sh`, `install.sh.sha256`, and notes on what changed.
- The workflow's permissions: `packages: write`, `contents: write`, `id-token: write`, `attestations: write`, and nothing else. `deploy.yml` is not touched: a tag deploys nothing to Cloudflare.
- **Once, by the user:** the package `library` on ghcr.io made public (**Package settings** → **Change visibility**), since a package starts private even from a public repository.
- **Acceptance:** the tag `v0.2.0` makes a public image for both architectures; `docker pull` with no login works; `gh attestation verify oci://ghcr.io/slidrhq/library:0.2.0 --repo slidrhq/library` passes; and the release's `install.sh`, downloaded as §5.1 shows, installs it on the user's Linux machine.

## P9. Moving over, cleaning up, documentation (last)

Done on 2026-10-27, on the branch `p9`: what each item became is said after it. The repository's secret `LIBRARY_MASTER_KEY` and the push to `main` are the user's.

- On Cloudflare:
  - the bootstrap of P3, checked against the real deployment: the editors were imported (`config/people.json`), the first of them the owner, before the owner made a `publish` token on 2026-10-25;
  - `LIBRARY_MASTER_KEY`, a secret of the repository that `deploy.yml` gives the Worker (`wrangler-action`'s `secrets`), and the Cron Trigger added (`wrangler.jsonc`; held back at the first deploy, 2026-10-25, by the user's choice);
  - nothing for the media: media.slidr.studio has been the bucket's own domain since 2026-10-25, with no Pages project (D10), and the Worker keeps `MEDIA_ZONE_ID` and `MEDIA_PURGE_TOKEN`;
  - `deploy.yml` and `.dev.vars.example` follow.
- Removed:
  - `LIBRARY_KEYS` and `key:<name>` as a way in (old records still show it): done on 2026-10-25, with the programs moved to tokens (`LIBRARY_TOKEN` of `import-library.mjs` and the app's `tag-elements.mjs`; `SLIDR_LIBRARY_TOKEN` of the studio);
  - `LIBRARY_EDITORS` (once imported), and `SESSION_SECRET` (once the vault holds the session key): the vault takes the session key over the first time it is asked for (`sessionKeyOf`), and `deploy.yml` asks, then deletes both secrets when the Worker still has them. The import's code stays, for a new deployment and for the tests.
- The README written again: the central library; a local library (installing it with the script, the command, updating, backing up, the ways of reaching it); settings, people, tokens and publishing. Also the OpenAPI (`openapi.ts`: the `bearer` and cookie schemes, the scopes, the routes, no `path`, no media settings).
- Other repositories, each in a commit of its own and only after asking:
  - the app: `docs/media-library.md` (approval publishes; a local library, in Docker on Linux, read at `<url>/media/`), and the help of `tag-elements.mjs` (`LIBRARY_TOKEN` is a person's token);
  - the studio: its README, "Publishing", and the text of the key in its panel.
- A security review of the whole branch (`/security-review`), and the audit of §12 checked entry by entry.
- A visual review of every new page (Profile, Members, Settings, Publications, the changes to Uploads):
  - in Hebrew and in English, at full width and at a narrow one, light and dark;
  - fix what it finds, then look again.

## Risks

| Risk                                                                                                                     | What is done                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merging into `main` deploys the central library to production, which the studio and the app use now.                     | P10–P13 change nothing the Worker runs. The Worker's tests and `pnpm dev` are checked before each merge, which is done only when the user asks.            |
| Other sessions change `main` (vendor/, the page, `server/core`) while this branch is open.                               | Rebase at the start of each phase and before each merge. P10's removals are commits of their own, easy to carry over a conflict.                           |
| This machine has no Docker, so the image cannot be tried here.                                                           | `image.yml` builds and tests it on GitHub's runners, on both architectures, on every push of the branch. The user's Linux machine is the last check (P12). |
| Nginx answers `/media/` otherwise than `serveMedia` does, and apps meet a difference.                                    | Nginx's types are written from `live.ts`, and the parity test compares the two answers over one folder, file by file.                                      |
| The bundle of the Node host misses an import of `vendor/` that the source resolves through `server/node.mjs`.            | A test starts the bundle, and every test of `image.yml` runs on it.                                                                                        |
| A port Docker publishes passes by `ufw` and `firewalld`, so a library meant for one machine is reached from the network. | The port is bound to `127.0.0.1` unless the installer chooses another way, and the script says so in the other ways.                                       |
| The owners of existing folders, or SELinux, keep the container (10001) from its folders.                                 | The script sets the folders' owner and mode, mounts them with `:Z` under SELinux, and `status` names a folder the container cannot write.                  |
| An app reads a changed file before the new manifest.                                                                     | The manifest goes last, the window is seconds, and the app refuses a file that does not match and reads it again later.                                    |
| A package on ghcr.io starts private.                                                                                     | The user makes it public once (P13), and the release pulls it with no login before it publishes the release.                                               |
| Open uploading is abused.                                                                                                | Limits, blocking, allowed domains, and every byte checked before anything is kept.                                                                         |
| The vendored code falls behind the app (the form of `managed.json`, the readers of the page).                            | The fixtures of `media.test.ts` fail on a difference. Re-vendor (`pnpm vendor`) when the app changes them.                                                 |
