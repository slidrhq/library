# Slidr Library — implementation plan

Status: **approved 2026-10-25**, then rebased onto `main` at 4e2bef5, which serves the media straight from R2 and keeps the publication's bookkeeping beside the uploads. It implements the [specification](SPEC.md). Section numbers such as §9.4 are the specification's.

`main` already has the publication (`worker/media/`). This plan moves it onto ports, adds a second host, people, tokens and stores, and makes approval publish.

## Order

```text
P1 core and ports ──► P2 Node host, vault, CLI ──┬──► P3 people and sign-in ──► P4 tokens ──┐
                                                 └──► P5 media stores: folder ──────────────┴──► P6 approval publishes ──┬──► P7 SFTP, FTP
                                                                                                                         └──► P8 Cloudflare from a machine
                                                                                                           P9 moving over and docs (last)
```

A local install that works end to end is **P1 to P6**: a local folder as its media, people and tokens, approval written into the media. P7 and P8 add the other stores. P9 moves the deployment on Cloudflare over and cleans up.

## How the work is done

- The work is on the branch `standalone`, in the worktree `.claude/worktrees/standalone`. Other sessions work in this repository's `main` at the same time (a re-vendoring was under way on 2026-10-25). The branch is rebased onto `main` at the start of each phase and before each merge. Nothing is stashed or reset in the main checkout.
- **A push to `main` deploys to production** (`.github/workflows/deploy.yml`, https://library.slidr.workers.dev). A phase is merged only when the Cloudflare host behaves as it did, or better, with the secrets it has. Until P9, the Cloudflare host keeps accepting `LIBRARY_EDITORS`, `LIBRARY_KEYS` and its Google secrets. Merging and pushing are done only when the user asks.
- A phase is done when:
  - `pnpm check` and `pnpm test` pass;
  - its acceptance holds;
  - its pages have been looked at in Hebrew and in English, and what that showed has been fixed.

## P1. Core and ports, with no change in behaviour

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

## P2. The Node host, the vault and the CLI

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

## P3. People, roles and signing in

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

## P4. Tokens and open uploading

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

## P5. Media stores: the folder, the bookkeeping, `/media/`

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

## P6. Approval publishes

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

## P7. SFTP and FTP (Node only)

- `server/host/node/media/sftp.ts` with `ssh2`:
  - the host key is checked by its SHA-256 fingerprint (`hostVerifier`);
  - the first **Test** answers the fingerprint, and Settings asks an admin to confirm it;
  - a changed host key answers `host-key-changed` and stops every write;
  - a private key (OpenSSH or PEM) with its passphrase, or a password;
  - replace by `posix-rename@openssh.com` where the server has it, else remove then rename (with a window that is documented);
  - before the manifest, it reads the manifest again and compares its hash (§4.5).
- `server/host/node/media/ftp.ts` with `basic-ftp`:
  - explicit FTPS by default, or implicit;
  - plain FTP only with "allow unencrypted FTP";
  - `RNFR`/`RNTO` to replace, falling back to remove then rename;
  - the same check of the manifest before it is written.
- Reads keep a cache by SHA-256 in the data folder, filled from the store, or from its public URL when one is set.
- Settings: the fields and keys of each, with the key pasted or chosen as a file.
- **Tests:** a SFTP server (`ssh2`'s `Server`) and an FTP server (`ftp-srv`) inside the tests:
  - publishing and putting back, through the tests of `media.test.ts` over each;
  - a wrong key, answered `store-unreachable` with why;
  - a changed host key, refused;
  - plain FTP refused unless allowed;
  - a manifest changed outside the library, refused.

## P8. Cloudflare from a machine (R2)

- `server/core/media/r2s3.ts`: the `MediaStore` of an R2 bucket through its S3 API, signed with SigV4 by `aws4fetch`, so it runs on both hosts. It uses `GetObject`, `PutObject` (the SHA-256 in `x-amz-meta-sha256`), `DeleteObject` and `ListObjectsV2`. The manifest is written with `If-Match` where R2 honours it on `PutObject`; check that first, else read again and compare its hash as for SFTP.
- The cache before the bucket's domain is emptied as on Cloudflare (`media/cache.ts`), with the zone's id and its purge token from the library's settings and vault.
- Settings on Node, for R2: the account ID, the bucket, its domain, the zone's id, the S3 credentials and the purge token. **Test** checks that they read and write that one bucket, and that the token may purge the zone.
- The steps to put an organization's own bucket under its own domain, with the zone's rules (README, "Serving the library").
- **Tests:**
  - the S3 API stood in for: the requests signed, the metadata, the conditional write of the manifest;
  - the tests of `media.test.ts` over it;
  - by hand, before merging: a bucket made for the test, written by a library on this machine, read at its domain by the app's reader.

## P9. Moving over, cleaning up, documentation

- On Cloudflare:
  - the bootstrap of P3, checked against the real deployment: `LIBRARY_OWNER` set, then the editors imported;
  - `LIBRARY_MASTER_KEY` set, and the Cron Trigger added;
  - the Pages project `slidr-media` deployed with its own R2 binding (P8);
  - `deploy.yml` and `.dev.vars.example` follow.
- Removed:
  - `LIBRARY_KEYS`, `LIBRARY_EDITORS` (once imported), and `SESSION_SECRET` (once the vault holds the session key);
  - `key:<name>` as a way in (old records still show it);
  - `scripts/import-library.mjs`'s `LIBRARY_KEY`, which becomes a token.
- The README written again: installing, settings, people, tokens, publishing, the stores. Also the OpenAPI (`openapi.ts`: the `bearer` and cookie schemes, the scopes, the new routes, no `path`).
- Other repositories, each in a commit of its own and only after asking:
  - the app: `docs/media-library.md` (approval publishes; a library of one's own), and the help of `media-publish.mjs` and `tag-elements.mjs` (`LIBRARY_KEY` is a person's token);
  - the studio: its README, "Publishing", and the text of the key in its panel.
- A security review of the whole branch (`/security-review`), and the audit of §12 checked entry by entry.
- A visual review of every new page (Profile, Members, Settings, Publications, the changes to Uploads):
  - in Hebrew and in English, at full width and at a narrow one, light and dark;
  - fix what it finds, then look again.

## Risks

| Risk                                                                                                  | What is done                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merging into `main` deploys to production, which the studio and the app's `media:publish` use now.    | The Cloudflare host keeps today's secrets and keys working until P9. Each phase is tested with `pnpm dev`, the Worker in its runtime, before it is merged, and merged only when the user asks. |
| Other sessions change `main` (vendor/, the page) while this branch is open.                           | Rebase at the start of each phase and before each merge. P1 moves `worker/` only, which those changes do not touch.                                                                            |
| An app reads a changed file before the new manifest (folder, SFTP, FTP).                              | The manifest goes last, the window is seconds, and the app refuses a file that does not match and reads it again later.                                                                        |
| SFTP and FTP servers replace files in different ways, and have no etag.                               | `posix-rename` where the server has it, otherwise remove then rename, documented. The lease, and the hash of the manifest compared before it is written.                                       |
| R2's S3 API may not honour `If-Match` on `PutObject`.                                                 | Checked at the start of P8. The lease, and the hash compared before writing, cover it.                                                                                                         |
| The keychain module has no binary for a platform, or there is no keychain (a server with no desktop). | `LIBRARY_MASTER_KEY`, or `--master-key-file` with a warning.                                                                                                                                   |
| Open uploading is abused.                                                                             | Limits, blocking, allowed domains, and every byte checked before anything is kept.                                                                                                             |
| The vendored code falls behind the app (the form of `managed.json`, the readers of the page).         | The fixtures of `media.test.ts` fail on a difference. Re-vendor (`pnpm vendor`) when the app changes them.                                                                                     |
