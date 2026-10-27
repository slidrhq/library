# Slidr Library — specification

Status: **approved 2026-10-25**, and P1–P8 of the [implementation plan](PLAN.md) are on `main`. **Revised and approved 2026-10-26**, and built on the branch `local-docker` (P10–P12): the central library stays on Cloudflare exactly as it is, and a local library is installed only on a Linux machine, in Docker, with Nginx inside, and its media on a disk of that machine (R1, R5 and R6; D12–D17). The media stores of SFTP, FTP and R2 from a machine go, and so does the OS keychain. This document describes where the library is going; the [README](../README.md) describes what it does today. Paths such as `desktop/…` and `packages/…` are of the app's repository, copied into `vendor/`.

## 1. Purpose

The library is the way in to the media library (`docs/media-library.md` of the app): people **view** it, and **manage** it. Content enters by an **upload**, through the REST API or by hand on the page. Each upload waits for **review**. When a reviewer approves it, **the library itself writes it into the media**, where every installed app reads it.

There are two kinds of library. The **central library** is Slidr's own, on Cloudflare: library.slidr.workers.dev, with its media at media.slidr.studio. A **local library** is an organization's own, installed on a Linux machine of its own, and its installed apps read the media there.

| #   | Requirement                                                                                                                                                                                                                                                                                | Where                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| R0  | The library writes approved content into the media. (2026-10-25)                                                                                                                                                                                                                           | [§9](#9-writing-approved-content-into-the-media)                          |
| R1  | The central library runs on Cloudflare, exactly as it does today. A local library can be installed only on a Linux machine, and its media is part of it: a folder on a disk of that machine. Its media is never Cloudflare, FTP or SFTP. (2026-10-26; it replaces R1 of 2026-10-25, below) | [§3](#3-decisions) D12, D13; [§4](#4-architecture)                        |
| R2  | How the library stores files is its own business, and has nothing to do with the API. (2026-10-25)                                                                                                                                                                                         | [§4.3](#43-state-store), [§4.5](#45-media-stores), [§10](#10-api)         |
| R3  | A person makes a token in their profile. The token, in a header, is all an upload needs. (2026-10-25)                                                                                                                                                                                      | [§7](#7-tokens-r3)                                                        |
| R4  | The library manages who may review, that is, approve uploads into the media. The installer is the first, and adds more people by email. (2026-10-25)                                                                                                                                       | [§6](#6-people-and-permissions-r4)                                        |
| R5  | A local library is installed with Docker: one image, with Nginx inside it, on a port of its own that collides with nothing else on the machine. (2026-10-26)                                                                                                                               | D14, D15; [§5.1](#51-on-a-linux-machine-in-docker), [§5.4](#54-the-image) |
| R6  | Beside the image, a script installs it, and asks for what an install cannot do without, such as the folder of the machine that is mapped to the media. (2026-10-26)                                                                                                                        | D16; [§5.5](#55-the-install-script)                                       |

R1 of 2026-10-25 read: "The library stands on its own, and can be installed locally. Its media may be a local folder, a server reached by FTP or SSH, or Cloudflare Pages. Each one takes a key that grants access, kept securely." P7 and P8 built SFTP, FTP and R2 from a machine for it; the revision takes them away (PLAN P10).

## 2. Today, and what changes

`main` (4c3e866) has P1–P8 of the plan:

- one core (`server/core/`) with two hosts;
- people, tokens and open uploading;
- approval that publishes at once, with the lease, the sweep and putting the media back;
- on a machine, the Node host (`server/host/node`), run from the repository with `pnpm library` on Windows, macOS or Linux. Its media is a folder, SFTP, FTP or R2 through its S3 API, as Settings names it, and its master key is in the OS keychain.

The central library is the Worker `library` (`server/host/cloudflare`), with its state in R2 (`UPLOADS`) and its media in R2 (`MEDIA`, `slidr-media`). media.slidr.studio is that bucket under its own domain, with Cloudflare's cache before it (D10).

| Today (`main`)                                                                                                                                        | Becomes                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The central library: the Worker, `UPLOADS`, `MEDIA`, media.slidr.studio, its secrets, its Cron Trigger off.                                           | **Unchanged.**                                                                                                                                                                                                                                                                         |
| The Node host runs from the repository, on Windows, macOS or Linux (`pnpm install; pnpm build; pnpm library init; pnpm library start`).               | It runs only in its Docker image, on Linux (§5.4). `pnpm library` stays the CLI, inside the image and for the tests.                                                                                                                                                                   |
| Its media is one of four stores that Settings names: a folder, SFTP, FTP, or R2 through its S3 API. Each store but the folder has a key in the vault. | Its media is one folder of the machine's own disks, mounted into the container, and named once, at install (D13). SFTP, FTP and R2 from a machine are taken away, with their code, packages, settings and tests. The vault keeps no key of the media.                                  |
| The master key is in the OS keychain, in `LIBRARY_MASTER_KEY`, or in a file.                                                                          | It is a file of the machine, outside the data folder, mounted into the container (§4.4). The keychain, and its native package, go.                                                                                                                                                     |
| Node serves everything on `127.0.0.1:5176`, and is reached from other machines with TLS of its own, or behind a proxy.                                | Nginx, inside the container, is its only door, on port 7543 of the machine (D14, D15). It serves `/media/` from the folder itself, and the page's built files, and passes the rest to Node, which listens inside the container only. TLS is Nginx's, or a proxy's of the organization. |
| The owner's one-time link is accepted from this machine only.                                                                                         | In a local library it is accepted from any address (D17).                                                                                                                                                                                                                              |
| Installing takes the repository, pnpm and a build.                                                                                                    | A script (`install.sh`, published with each release) checks the machine, asks a few questions, writes a compose file, and starts the image from `ghcr.io` (§5.5).                                                                                                                      |

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Anyone who signs in may make tokens and upload.** Uploads wait for review, and only members review. Admins can limit sign-in to email domains, block a person, and cap what each person keeps waiting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The user's choice. Since uploading is open, the library needs the limits and the block list ([§6.4](#64-open-uploading-and-its-limits)).                                                                                                                              |
| D2  | **Sign-in: a one-time link for the owner, plus OIDC for everyone.** OIDC comes with presets for Google (the default) and Microsoft, and takes any issuer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The user's choice. A local install works with no setup at all for its installer. Adding people by email needs a provider that vouches for their addresses, and a closed network can use its own (Entra, Keycloak).                                                    |
| D3  | **Approval writes to the media immediately**, through today's publication. One publication runs at a time. An upload approved while one runs is written by the sweep (every minute). A write that fails leaves the upload approved, with the error, and it is tried again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The user's choice. The publication code stays as it is: approving calls it for the one upload.                                                                                                                                                                        |
| D4  | **Manual upload stays as it is** (Uploads → New upload) until the user says what it lacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The user will check it again ([§15](#15-open-questions)).                                                                                                                                                                                                             |
| D5  | **One core, two hosts.** The core is web-standard (`Request` → `Response`, `crypto.subtle`). Each host gives it a state store, a vault and a media store. The central library is the Cloudflare host, and a local library is the Node host, in its image (D12).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The Worker keeps working as it does, and a local library runs the very same code.                                                                                                                                                                                     |
| D6  | **Every key is kept encrypted in a vault** (AES-256-GCM). The master key lives outside the store: in a file of the machine outside the data folder for a local library (2026-10-26; it was the OS keychain), and in a Worker secret on Cloudflare. A key is write-only: no route returns it, and it is never logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A copied data folder, a backup of it, or a leaked bucket reveals no key. A server in Docker has no keychain.                                                                                                                                                          |
| D7  | **The API speaks of the published library, never of its storage.** Routes name uploads, items, languages and the paths of the library's own manifest, which `/media/` publishes anyway. No route names a store, a bucket, a folder, a server, or a key of the library's bookkeeping (`_history`, `_staged`, the lock), and no answer reveals any of them. Upload views lose `path`, which is the library's to decide.                                                                                                                                                                                                                                                                                                                                                                                                                                     | R2. A target can change without a change to any client.                                                                                                                                                                                                               |
| D8  | **A token has a scope.** `upload` is the default, open to everyone: make, read, change and withdraw one's own uploads. `publish` is open to admins only: write an author's files, import, and run the publication of uploads already approved. **Approving and administering need a session** on the library's page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | R3 says a token is for uploading. The studio and `import-library.mjs` are programs that write into the media without review, so they need the `publish` scope, while approval stays a person's act.                                                                   |
| D9  | **The library serves its media at `/media/`**, and the page always reads the media there. The Worker serves it with `serve.ts` over its bucket. A local library serves it with Nginx, straight from the folder (§4.6), and it is the address the local library's installed apps read (ADR-107 of the app).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A folder has no web server of its own, and the page should show the library it manages.                                                                                                                                                                               |
| D10 | **The central library's media is the R2 bucket under its own domain, with Cloudflare's cache before it** (`main`, 4e2bef5 and 5f8a6e1; this replaced a Pages site in front of the bucket, and was set up for media.slidr.studio on 2026-10-25, when the Pages project `slidr-media` was deleted; ADR-113 of the app). No Worker and no Pages Function runs when an app reads the library, and a publication empties the cache of what it wrote (`media/cache.ts`), with the zone's purge token. The domain's zone needs the rules of the README's "Serving the library": Smart Tiered Cache; the cache rules (a file a day, the manifest two hours); the response headers (CORS, `X-Slidr-Library: live`); and a configuration rule that rewrites no HTML, since the app checks every file against its SHA-256. A local library never writes to R2 (D12). | Reading the library costs nothing per request, where a Worker or a Pages Function in front of the bucket is billed for every one. Pages deployments would bring their 25 MiB file limit, catalog splitting, and an asset-hash API that wrangler keeps to itself.      |
| D11 | **The bookkeeping lives in the state store, not in the media** (done on `main`, 4e2bef5). This covers the history of each publication, the files staged for an author's publication, and the lock. No `_…` key was ever written to the bucket in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | R2. A folder that a web server publishes as it is must not publish the library's bookkeeping too.                                                                                                                                                                     |
| D12 | **Two libraries, each on one host** (2026-10-26). The central library is the Worker on Cloudflare, and nothing in how it runs changes. A local library is the Node host, in its Docker image, on Linux. Both run the same core, page and API. Neither has the other's stores: the Worker's media is its bucket, and a local library's media is its folder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The user's choice (R1). One store for each library is less code to keep, no native packages (`ssh2`, the keychain), and no keys of a remote store to guard.                                                                                                           |
| D13 | **A local library's media is a folder on the machine's own disks**, mounted into the container at `/library/media`, and named once, by the install script. It is not a setting of the page: moving it is a new install over the same data folder. The script refuses a folder on a network file system (NFS, SMB/CIFS, SSHFS or any other FUSE mount, 9p, Ceph, GlusterFS), and a folder that holds anything but a library.                                                                                                                                                                                                                                                                                                                                                                                                                               | R1: "a locally defined disk". A rename is atomic only within a local file system, and §9.4 rests on it. With the folder fixed by whoever runs Docker, no admin of the page can point the library at another folder of the machine.                                    |
| D14 | **One image, with Nginx inside** (`ghcr.io/slidrhq/library`, for linux/amd64 and linux/arm64). Nginx is the container's only door: it listens on 8080 inside the container, serves `/media/` from the folder and the page's hashed files (`/assets/`), and passes `/api/`, `/auth/` and the page itself to Node at `127.0.0.1:5176`, which listens inside the container only. `tini` runs both. When either ends, the container ends, and Docker starts it again (`restart: unless-stopped`). Everything in it runs as one user, never as root: the account of the machine that the script makes for the library (10001 when the image is run by hand).                                                                                                                                                                                                   | R5. Nginx serves the media's files from the disk (ranges, `If-None-Match`, `sendfile`), so Node never reads a file an app asks for. One image is one thing to install, update and roll back.                                                                          |
| D15 | **Port 7543 by default.** The machine publishes the container's 8080 as 7543 ("SLID" on a phone's keys). No common server software uses it, and it is below Linux's ephemeral range (32768–60999), so an outgoing connection never takes it. The script checks that nothing listens on the port, and that no container publishes it, and asks for another when one does. It binds `127.0.0.1` unless the library is to be reached from other machines (§5.1).                                                                                                                                                                                                                                                                                                                                                                                             | R5: a port of its own that collides with nothing on the machine. The usual ports (80, 443, 3000, 5000, 5173–5176, 8000, 8080, 8443, 9000) are where other servers and dev servers live. Binding to loopback by default publishes nothing until the installer says so. |
| D16 | **A script installs it, and a command of the machine runs it after** (§5.5). `install.sh` is published with each release, beside the image of the same version, and pins that image by its digest. It asks only what an install cannot do without, and takes every answer as an option, for an install with no one at the keyboard. It installs `slidr-library`, a command of the machine for the rest: `login`, `status`, `logs`, `update`, `stop`, `start`, `sign-in`, `owner`, `vault rotate`, `uninstall`.                                                                                                                                                                                                                                                                                                                                            | R6. Pinning by digest installs exactly what the release built and tested. `update` runs the script of the newer release, so a version that needs a new step brings it along.                                                                                          |
| D17 | **A local library's owner link works from any address.** Every request reaches Node through Nginx, and a request from the machine itself reaches Nginx through Docker's bridge, so "from this machine" cannot be told apart from the network. The link stays one use, 10 minutes, 256 bits, kept as a hash, and only someone who may run Docker on the machine can make one (`slidr-library login`).                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A Linux server usually has no browser, and its owner opens the link from their own computer. Whoever may run Docker on the machine owns the library anyway: they can read its data folder.                                                                            |

## 4. Architecture

```text
 the central library (Cloudflare)               a local library (Linux, Docker)
 ────────────────────────────────               ─────────────────────────────────────────────────────
 the page, REST clients                         the page, REST clients, the organization's apps
          │                                                       │ :7543 on the machine
          ▼                                                       ▼   (TLS of Nginx, or of a proxy)
 Worker `library` (core)                        ┌─────────── container, user 10001 ───────────┐
   ├── state: R2 `UPLOADS`                      │ Nginx :8080 ── /media/, /assets/ ─► files   │
   └── media: R2 `MEDIA` ──┐                    │   └─ /api/, /auth/, the page ─► Node :5176   │
                           ▼                    │                (core, the sweep's timer)    │
         media.slidr.studio (the bucket's own   └──────┬──────────────┬──────────────┬───────┘
         domain, Cloudflare's cache)                   ▼              ▼              ▼
                           │                    /library/data   /library/media  /library/keys
                           ▼                    the state store  the media       the master key
                    installed apps              (folders of the machine, mounted)

 core: /auth  /api/me  /api/uploads  /api/library  /api/publish  /api/members  /api/settings  /media/
```

### 4.1 Core

The core is `server/core/`, free of any host: it uses only the web's APIs. Every route is a function `(request, ctx) → Response`. `ctx` carries the ports below, the configuration, the client's address and the person making the request. The core holds:

- the routes;
- the upload handlers (`designs.ts`, `templates.ts`, `tags.ts`) and their checks;
- the publication (`publish.ts`, `merge.ts`, `files.ts`, `import.ts`, `serve.ts`);
- the roles and the tokens.

### 4.2 Hosts

| Host                                      | Runs as                                                                                                                                          | State store                                 | Master key                                                                                   | Media store                                          | Jobs                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| **Cloudflare** (`server/host/cloudflare`) | The Worker `library`: the central library, as today.                                                                                             | R2 (`UPLOADS`, as today)                    | The Worker secret `LIBRARY_MASTER_KEY`.                                                      | R2 (the binding `MEDIA`, as today)                   | A Cron Trigger (off)   |
| **Node** (`server/host/node`)             | A local library: one container of the image (§5.4), Nginx at its door, and Node inside it on `127.0.0.1:5176`. The tests run it from the source. | The data folder, mounted at `/library/data` | A file, mounted at `/library/keys/master.key` (§4.4). `LIBRARY_MASTER_KEY` serves the tests. | The media folder, mounted at `/library/media` (§4.5) | A timer in the process |

A local library runs on Linux only. Node runs from the source on any system for the tests and for working on the code, but that is not an install.

### 4.3 State store

The state store holds everything the library keeps for itself:

- uploads and their files, until they are written;
- people, tokens and settings;
- sealed keys;
- the bookkeeping of its publications.

Its interface is `Bucket` (get, put with `onlyIf.etagMatches`, delete, list by prefix with metadata), so R2 serves it as it is. On Node it is the data folder:

- one file per key, written to a temporary name and renamed into place;
- a sidecar for the metadata;
- the etag is the content's SHA-256;
- a lock inside the process makes put-if-match atomic. There is one server process per data folder: the script stops the library before it runs anything else over the folder.

```text
config/library.json                 settings that are not secret (§5.3)
vault/<name>.json                   a sealed key (§4.4)
people/<email>.json                 a person: role, blocked, who added them and when, when last seen
people/<email>/tokens/<id>          the tokens of a person, by id → the hash
tokens/<sha256 of token>.json       a token: id, owner, name, scope, created, expires, last used
links/<sha256 of code>.json         a one-time sign-in link of the owner
uploads/<id>.json, files/<id>/<n>   uploads and their files, as today
media/history/<published>/…         what a publication replaced: the manifest before it, and each file it wrote over
media/staged/<sha256>               a file of an author's publication, until it is published
media/lock.json                     the publication that runs, and until when it holds the library
audit/<time>-<random>.json          who changed members, settings, keys and tokens
```

No route of the API names a key of the store. Upload files are addressed as `/api/uploads/{id}/files/{name}`, by the name the upload gave them.

### 4.4 Vault

```json
{
  "v": 1,
  "kid": "k1",
  "iv": "<12 bytes, base64url>",
  "data": "<ciphertext and tag>",
  "set": "2026-10-25T10:00:00Z",
  "by": "owner@example.org"
}
```

- Each key is sealed with AES-256-GCM, under a fresh random IV. The additional data is `slidr-library:vault:<name>`, so a sealed key moved to another name does not open.
- The master key is 32 random bytes made at install. It is never written in the state store:
  - a local library: the file `master.key` in a folder of the machine apart from the data folder (`/etc/slidr-library/keys/` by default, mode 0700, the file 0600, both the container user's), mounted at `/library/keys/`. A backup of the data folder alone reveals no key. `LIBRARY_MASTER_KEY` holds it for the tests and for a run from the source;
  - Cloudflare: the Worker secret `LIBRARY_MASTER_KEY`.
- `kid` names the master key. `slidr-library vault rotate` seals every key again under a new master key: the new key is written beside the old one (`master.key.next`), every key is sealed again, and the new key is then renamed over the old, so a rotation stopped half way loses nothing.
- The keys: `oidc` (the OIDC client's secret) and `session` (the key that signs cookies, made at install). A local library's media has no key (D13).
- A key is write-only. Settings shows only whether it is set, when and by whom. Logs, errors and the audit never hold a key, nor a token.

### 4.5 Media stores

The publication code (`live.ts`, `publish.ts`, `files.ts`, `import.ts`, `serve.ts`) reads and writes the media through the port `MediaStore`: read a file (its bytes, size and SHA-256), write a file with its SHA-256 and type, remove a file, list the files with their SHA-256, and write the manifest over the one read (`etagMatches`). Each library has one store:

| Library | Store      | Settings                                                                              | Key                                                                   | Reads and writes                                                                                                                                                           |
| ------- | ---------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Central | R2         | The binding `MEDIA`, and the zone's id (`MEDIA_ZONE_ID`), as today.                   | The zone's purge token (`MEDIA_PURGE_TOKEN`), a secret of the Worker. | Through the binding. Apps read the bucket at its own domain, through Cloudflare's cache, which a publication empties of what it wrote (`media/cache.ts`; D10).             |
| Local   | The folder | None in the page. The folder the install named, at `/library/media` in the container. | None. Access is the container user's permission on the folder.        | From the folder, and into it: a hidden temporary name in the same folder, then a rename. A file's SHA-256 comes from the manifest. The manifest's etag is its own SHA-256. |

- **Test** (Settings, and `slidr-library status`) reads the manifest, and writes and removes a probe file (`.slidr-library-probe`), which is never part of the library and which Nginx never serves.
- **An empty store** is seeded from a published library by today's import (`import.ts`), which copies every file checked against its manifest and writes the manifest last. The source is media.slidr.studio by default, or any address.
- **The public URL**, the address installed apps are given: media.slidr.studio for the central library, and `<the library's URL>/media/` for a local one. It answers 404 for a missing file (docs/media-library.md, "A library of your own").
- **Taken away** (2026-10-26, PLAN P10): SFTP, FTP, and R2 through its S3 API from a machine, with their settings, keys, host keys, read caches and tests.

### 4.6 The media at `/media/`

The central library answers `GET`/`HEAD /media/<path>` with `serveMedia` over its bucket, as today. A local library answers it with Nginx, from the folder itself, and Nginx answers what `serveMedia` answers:

- the type of `live.ts` (the image's Nginx types are written from it when the image is built, so the two never part);
- `Cache-Control` of `live.ts`: `no-cache` on `manifest.json`, `public, max-age=0, must-revalidate` on every other file;
- `Access-Control-Allow-Origin: *`, the CORS headers of `serve.ts`, `X-Content-Type-Options: nosniff` and `X-Slidr-Library: live`; `OPTIONS` answered `204`, any method but `GET`, `HEAD` and `OPTIONS` answered `405`;
- 404, with `serve.ts`'s page, for a missing file, and for every path `isLibraryPath` refuses: a hidden part (`.git`, `.slidr-library-probe`, the temporary names of a write), a first `_`, `\`, `:`. No folder is listed, and no link is followed (`disable_symlinks on`);
- an `ETag` of Nginx's own (the file's size and time), with `304` for a reader that has it. It is not the SHA-256, as R2's is not at media.slidr.studio: the app checks every file against its manifest;
- also `Content-Security-Policy: sandbox`, so an HTML file of the library (`templates/reference-decks/*.html`, which the app reads as text) runs nothing at the library's own origin, where the page and its session live.

"Only what the manifest names" (the security review of 2026-10-25, in `serve.ts`) was there because Settings could point a folder store at any folder of the machine. A local library's folder is the library's alone (D13): the script makes it so, the bookkeeping is in the state store (D11), and what the library writes there before a rename, and its probe, have hidden names. So Nginx serves the folder as it is. Node still answers `/media/` with `serveMedia` when it runs without Nginx, in the tests.

The page is built with `__SLIDR_MEDIA_PATH__` read from `globalThis.__slidrMediaPath`, which Node sets to `/media/` in the page it serves on a local library. The upload checks read the store (`libraryIn`).

Reading the media is public, as the published library is. Only managing it needs a person.

### 4.7 Jobs

- **The lease.** One publication or author's publication runs at a time. It holds `media/lock.json` in the state store (10 minutes). The lock is taken, kept and let go with put-if-match, so two never take it together. It stays in the store once made, written as free when let go, since no store makes a file only when it is absent. A publication keeps it once a minute while it writes, and checks it still holds it before it writes the manifest.
- **The sweep.** Each minute it publishes the uploads that are approved and not yet written, oldest first, up to 50, as `POST /api/publish` does. It skips an upload that is waiting before its next try (§8). It runs from a timer of the process in a local library, and from a Cron Trigger on Cloudflare, which is off until the user turns it on.
- **Clearing.** Once a day, rejected uploads older than 30 days are removed, and the history of publications is kept to the last 100.

## 5. Installation (R1, R5, R6)

### 5.1 On a Linux machine, in Docker

```sh
curl -fsSLO https://github.com/slidrhq/library/releases/latest/download/install.sh
curl -fsSLO https://github.com/slidrhq/library/releases/latest/download/install.sh.sha256
sha256sum -c install.sh.sha256
sudo bash install.sh
```

- **What the machine needs:** Linux on x86-64 or ARM64; Docker Engine 24 or later, run by root (not rootless), with its compose plugin (`docker compose`, v2); `ss` (iproute2), `findmnt` (util-linux) and `curl`. The script checks each of them and stops, saying what is missing. It never installs Docker itself.
- **What it asks** is in §5.5. What it writes, where:

  | On the machine                                    | In the container           | What                                                        |
  | ------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
  | `/etc/slidr-library/compose.yaml`                 | —                          | The service: the image by its digest, the port, the folders |
  | `/etc/slidr-library/library.env`                  | —                          | The answers of the install. Nothing in it is secret.        |
  | `/etc/slidr-library/keys/` (0700)                 | `/library/keys/`           | The master key (§4.4)                                       |
  | The data folder (`/var/lib/slidr-library/`, 0700) | `/library/data/`           | The state store (§4.3)                                      |
  | The media folder (asked; 0755)                    | `/library/media/`          | The media (§4.5)                                            |
  | The certificate and its key, when given           | `/library/tls/`, read-only | Nginx's TLS                                                 |
  | `/usr/local/bin/slidr-library`                    | —                          | The command of the machine (D16)                            |

  Every folder mounted belongs to `slidr-library`, a system account of the machine with no login that the script makes for the library, and which the container runs as: no other account of the machine shares its user id. The media folder may be read by anyone, as the library is public.

- **Reaching it.** The script asks which of three ways:
  1. **This machine only** (the default): the port is bound to `127.0.0.1`, over HTTP, and the URL is `http://127.0.0.1:7543`. Another computer reaches it only through an SSH tunnel, so it suits a trial, or a library its owner runs alone.
  2. **HTTPS, by Nginx**, with a certificate and its key from the machine: the port is bound to every address (or one named), and the URL is `https://<name>:7543`.
  3. **Behind the organization's own HTTPS proxy**: the port is bound to `127.0.0.1` when the proxy is on the same machine, or to an address named. The URL is the proxy's, and Nginx takes `X-Forwarded-For` and `X-Forwarded-Proto` only from the proxy's address.

  Plain HTTP beyond the machine is not offered: the session's cookie and the owner's link would cross the network as they are. Node trusts Nginx's `X-Forwarded-*`, from `127.0.0.1` only (`fromThisMachine`), and answers only a request that names it by its URL's host, as today (DNS rebinding).

- **The command of the machine** (`slidr-library`):

  | Command                    | Does                                                                                                                                                     |
  | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `login`                    | Prints the owner's one-time link (§6.2).                                                                                                                 |
  | `status`                   | The version, whether it runs and is healthy, the URL, the folders and their free space, and the store's **Test**.                                        |
  | `logs [-f]`                | Nginx's and Node's log.                                                                                                                                  |
  | `stop`, `start`, `restart` | The service.                                                                                                                                             |
  | `update [<version>]`       | Downloads that release's script (the newest by default), checks its SHA-256, and runs it as an update (§5.5).                                            |
  | `change`                   | Runs the machine's copy of the script again, to change how the library is reached, or its port.                                                          |
  | `sign-in …`                | Names the provider everyone else signs in through, as `pnpm library sign-in` does; the secret is asked for.                                              |
  | `owner <email>`            | Hands ownership to another member, for an owner who has lost their way in (§6.1).                                                                        |
  | `vault rotate`             | A new master key (§4.4), then a restart.                                                                                                                 |
  | `uninstall [--purge]`      | Removes the service, the compose file and the command. The data, keys and media folders stay, unless `--purge` is given and their names are typed again. |

- **Updating.** A newer image works over the same folders. A version that changes the state store's form moves it at its first start, and says so in its log. Going back to an older version is `update <version>`, for versions that read the store as it is.
- **Backing up.** The data folder, the keys folder (kept apart from the data folder's backup), and the media folder. To restore them, put them back and run the script with the same folders: it finds the library there and keeps it.

### 5.2 On Cloudflare

The central library is today's deployment, unchanged (D12), plus (PLAN P9, 2026-10-27):

- **The secret `LIBRARY_MASTER_KEY`**, a secret of the repository that each deploy gives the Worker. The vault takes over the key the sessions were signed with (`SESSION_SECRET`) the first time it is asked for, so no one is signed out, and the deploy then takes `SESSION_SECRET` and `LIBRARY_EDITORS` (imported once) away.
- **Its jobs**, from a Cron Trigger, once a minute (§4.7).
- **A first owner.** The secret `LIBRARY_OWNER` names the owner once, at the first start, and after that the store is the truth. There is no one-time link on Cloudflare, so the owner signs in through OIDC. Until OIDC is set, the Google client of today's secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) serves as its Google preset.

The media store is the bucket `MEDIA`, as today.

### 5.3 Settings

The Settings page is for admins. It keeps its values in `config/library.json` and the vault:

- **Library:** its URL, which the page shows and does not change. On Cloudflare it is the Worker's own, as it always was. In a local library the script sets it (`start --url`): it goes with the port, the certificate and the proxy, which the compose file holds.
- **Media:**
  - where it is: the bucket on Cloudflare; in a local library, the folder of the machine as the script named it, and how much room is left on its disk. Neither is changed here;
  - **Test**;
  - **Seed**, for an empty store;
  - the public URL that installed apps are given, with the line to give them: the policy, or `/MEDIA=` of the installer, from docs/media-library.md.
- **Sign-in:**
  - the OIDC provider: Google, Microsoft, or another issuer;
  - its client ID and secret;
  - the redirect URI to register with the provider (`<url>/auth/callback`);
  - the domains whose addresses may sign in (empty: any).
- **Uploads:** the limits of §6.4.

Each change is tested before it is kept: a provider's discovery document is read. Every change goes into the audit.

### 5.4 The image

- **Its name:** `ghcr.io/slidrhq/library`, public, tagged `<version>` (such as `0.2.0`), `<major>.<minor>` and `latest`, for linux/amd64 and linux/arm64. Its labels name the source, the version, the commit and the license (AGPL-3.0-only).
- **Built** by GitHub Actions from a tag `v<version>`, after `pnpm check` and `pnpm test`, with an SBOM and a build provenance that GitHub attests (`gh attestation verify`). A push to `main` deploys the central library and builds no image; a tag builds an image and deploys nothing.
- **What it holds:**
  - Node, the version CI tests with, from its official slim Debian image, pinned by digest;
  - Nginx and `tini`, from Debian's packages;
  - the built page (`dist/client`), and the Node host bundled into one file (`dist/node/library.mjs`).

  No pnpm, no source, no compilers, no shell tools beyond the base image's.

- **How it runs** (the compose file the script writes): as the account `slidr-library`; its root file system read-only, with `/tmp` in memory for Nginx's and Node's temporary files; every capability dropped, and `no-new-privileges`; `restart: unless-stopped`; Docker's log kept to 5 files of 10 MB.
- **Its entry** (`tini` → `slidr-library-entry`):
  - `serve`, the default: starts Node (`start --behind-proxy`, the folders of `/library/`, the URL of `LIBRARY_URL`), waits until it answers, then starts Nginx. When either ends, the other is stopped, and the container ends with its code;
  - `init`: makes the master key, the session key and the owner, and sets the URL. The script runs it once, in a container of its own, before the service starts;
  - any other command goes to the CLI (`login`, `seed`, `sign-in`, `vault rotate`, `status`).
- **Its health** (`HEALTHCHECK`): `GET /api/me` through Nginx, every 30 seconds.
- **Its log:** Nginx's access log without query strings (the owner's link carries its code in one), and Node's log, both to Docker's log.

### 5.5 The install script

`install.sh` is bash, checked by `shellcheck`. It writes nothing until its summary is accepted, and says what each step does.

1. **Checks** the machine (§5.1), and that it runs as root.
2. **Asks**, each question also an option for an install with no one at the keyboard:

   | Question                                                                                | Option                                                                                                          | Default                      |
   | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
   | Which folder of this machine is the library's media?                                    | `--media <dir>`                                                                                                 | none: it must be answered    |
   | The owner's email address                                                               | `--owner <email>`                                                                                               | none: it must be answered    |
   | How is it reached: this machine only, HTTPS with a certificate here, or behind a proxy? | `--reach local\|https\|proxy`, with `--url`, `--tls-cert`, `--tls-key`, `--proxy <address>`, `--bind <address>` | this machine only            |
   | The port                                                                                | `--port <n>`                                                                                                    | 7543                         |
   | The data folder                                                                         | `--data <dir>`                                                                                                  | `/var/lib/slidr-library`     |
   | Seed the media from the central library? (only when the folder is empty)                | `--seed [<address>]` or `--no-seed`                                                                             | yes, from media.slidr.studio |

   `--yes` takes the defaults and asks nothing. A question that must be answered and was not stops the script, which names what is missing.

3. **Checks the answers:**
   - the media folder: an absolute path, on a local file system (`findmnt`, D13); empty, or a library already (it has `manifest.json`), and otherwise refused, naming what is in it (a disk's root holds `lost+found`: the script suggests a folder inside it); not the data folder or the keys folder, inside either, or holding either; with room for the library when it is seeded (the sizes in the source's manifest, and 10% more);
   - the port: free (`ss`), and not published by another container; asked again when taken;
   - HTTPS: the certificate and its key are readable, and match;
   - a proxy: its address is an address.
4. **Shows a summary**, and goes on only when it is accepted.
5. **Writes** the folders (their owner and modes), `compose.yaml` and `library.env`. Under SELinux in enforcing mode the folders are mounted with `:Z`. In the HTTPS and proxy ways, it says that a port Docker publishes passes by `ufw` and `firewalld` rules, so the port is bound only where it should be.
6. **Pulls** the image by its digest, runs `init` in a container of its own, seeds the media (showing how far it got), starts the service, and waits until it is healthy.
7. **Installs** `/usr/local/bin/slidr-library`.
8. **Prints** the URL, the owner's one-time link (valid for 10 minutes; `slidr-library login` makes another), and the address installed apps are given (`<url>/media/`).

**Run again** on a machine where the library is installed, it reads `library.env`, and offers to update to its own version (the default; this is what `slidr-library update` runs), to change how the library is reached or its port, or to stop. It never empties, moves or writes over the data, keys or media folders.

## 6. People and permissions (R4)

### 6.1 Roles

| Can                                                                                                        | Anyone | Signed in | Reviewer | Admin | Owner |
| ---------------------------------------------------------------------------------------------------------- | :----: | :-------: | :------: | :---: | :---: |
| See the library, read `/media/`, read the API's description                                                |   ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| Make and revoke their own tokens (`upload`); upload; change and withdraw their own uploads while they wait |        |     ✓     |    ✓     |   ✓   |   ✓   |
| See every upload; approve, reject, send back; publish what waits; **Try again**                            |        |           |    ✓     |   ✓   |   ✓   |
| Tokens with the `publish` scope; an author's publication; import                                           |        |           |          |   ✓   |   ✓   |
| Add and remove reviewers and admins; block people; revoke any token                                        |        |           |          |   ✓   |   ✓   |
| Settings: the media's **Test** and **Seed**, limits                                                        |        |           |          |   ✓   |   ✓   |
| Hand ownership to another member; name how people sign in (whoever names the provider says who each is)    |        |           |          |       |   ✓   |

- The **owner** is the installer, and there is exactly one. No one removes the owner or changes the owner's role. The owner hands ownership over in Settings, or from the machine (`slidr-library owner <email>`).
- **Members** are people with a role. An admin adds one **by email** with a role (reviewer or admin), before or after that person has ever signed in. The role takes effect at their next request, because roles are read from the store on every request, never from the session. Removing a member, or changing their role, takes effect at once. A `publish` token whose owner is no longer an admin stops working at once.
- **A person who signs in** without a role is an uploader. They see their own uploads only.
- A reviewer may approve their own upload. The upload's history records who uploaded it and who approved it ([§15](#15-open-questions)).

### 6.2 Signing in

- **OIDC.** The authorization code flow, with PKCE, `state` and `nonce` (`server/core/auth.ts`, `oidc.ts`): the endpoints come from the issuer's discovery document. Google is the default issuer, and Microsoft (`login.microsoftonline.com/<tenant>/v2.0`) is a preset. The ID token comes straight from the token endpoint, so its issuer, audience, expiry and nonce are checked. The address must be verified (`email_verified`), and must be in an allowed domain when domains are set.
- **The owner's one-time link** (a local library only). `slidr-library login` makes a 32-byte code and keeps only its hash, for 10 minutes and one use, and prints `<url>/auth/local?code=…`. `/auth/local?code=` accepts it from any address (D17), then signs in the owner. This is how a local library's owner signs in with no provider at all. Others need OIDC, and the Members page says so until it is set.
- **The session**: an `HttpOnly` cookie, `SameSite=Lax`, `Secure` with the `__Host-` prefix over HTTPS, signed with the `session` key, for 14 days. It holds who the person is (email, name, provider), not what they may do. A request that changes something, sent with a session, must come from the library's own origin. **Sign everyone out** (Settings) makes a new `session` key.

### 6.3 Blocking

An admin may block an address, whether it is a member or not. A blocked person can still see the library, but cannot upload, and their tokens are refused. Blocking a member also takes their role away. Unblocking does not give it back.

### 6.4 Open uploading, and its limits

Anyone who signs in may upload (D1), so each person is limited. An admin may change every limit in Settings:

- at most **20** uploads waiting (pending) at once;
- at most **200 MiB** in the files of their waiting uploads;
- at most **10** tokens;
- at most **60** writes a minute per person, which answer `429` with `Retry-After` beyond that.

## 7. Tokens (R3)

- **Made in the profile.** The page's **Profile** (from the account button) lists a person's tokens and makes new ones. A token has:
  - a name, such as "Studio on my laptop";
  - a scope: `upload`, or, for an admin, `publish`, which also uploads;
  - an expiry: 30, 90 (the default) or 365 days, or none.
- **Shown once.** The token is `slk_` followed by 43 characters (32 random bytes, base64url). The page shows it once, with a copy button and an example request. The library keeps only its SHA-256, with:
  - its id, its owner, its name and its scope;
  - its first 6 characters, to tell it apart in the list;
  - when it was made, when it expires, and when it was last used (written at most once an hour).
- **Used alone.** `Authorization: Bearer slk_…` is all a request needs. It carries no cookie, no `Origin` and no other header of the library's. The token acts as its owner: what it does is recorded as that person, "by token \<name\>".
- **What a token may do** (D8):
  - `upload`: read the API's description and `GET /api/library`; make uploads; and list, read, change and withdraw its owner's own;
  - `publish`, as well as that: `POST /api/publish`, `POST /api/library/import`, `PUT /api/library/staged/…` and `POST /api/library/files`.

  Every other route, such as approving or Settings, answers `403 token-scope`. A request that carries a token is judged by the token alone, and its cookie is ignored.

- **Refused** with `401`: a token that is unknown, revoked or expired, or whose owner is blocked. Nothing in the answer tells these cases apart. A `publish` token whose owner is not an admin answers `403 token-scope` on the publish routes.
- **Revoked** by its owner in the profile, by an admin, and all at once when its owner is blocked.

## 8. Uploads and review

The kinds of upload, and how each is checked, stay as they are (README, "Uploading"). What changes is who does what, and when an approved upload is written:

```text
           upload                approve: checked, then written at once
 (new) ──────────► pending ───────────────► accepted ──────────────────► published
                    ▲  │ reject              │  │ cannot be written now: stays accepted,
                    │  ▼                     │  │ with publication.error; the sweep tries again
                 rejected ◄──────────────────┘  │
                    send back / reject (while it waits to be written)
```

- **pending**: it waits, and its uploader may still write it in more languages, or withdraw it.
- **accepted**: a reviewer approved it, after it was checked again against the media as it is now. The same request then publishes it (`publish(…, [id])`), and answers what the publication did. While it waits to be written (another publication held the lease, or the write failed), a reviewer may still send it back or reject it.
- **published**: the media has it. The upload records when it was published.
- **A write that cannot be made now** (the lease is held, the store cannot be reached, `PublishError`) leaves the upload `accepted`, with `publication: { message, at, attempts }`. The sweep tries again after 1, 5 and 30 minutes, then leaves it for **Try again**.
- **An upload that no longer holds** when it is written (someone took its id meanwhile) goes back to `pending`, with a note that says why, so its uploader can fix it. The rest of the publication goes on without it.
- **Marked published by hand.** This answers `409 publish-instead` once the library is live. The way back from `published` to `accepted` goes away with it.

## 9. Writing approved content into the media

### 9.1 A publication

The publication is `publish.ts`:

- it runs over the media store, with its bookkeeping in the state store (D11);
- approving and the sweep start it;
- a failure part-way puts the media back as it was (§9.4).

It takes the uploads named, or every accepted one, oldest first, up to 50. It reads what it changes from the store as it is now, checks each upload again, applies each (`merge.ts`), and writes.

### 9.2 What each upload changes

These are `merge.ts`, unchanged:

| Upload                                                                 | Changes in the media                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `designs: add`                                                         | Adds `images/designs/<id>.webp` (and `<id>-bg.webp`). In `elements/designs/managed.json` (written compact) it sets the design's names, group, slides, subject, size and tags (`mergeDesign`). Adds the picture of each slide the galleries show that it brings, `images/designs/thumbs/320/<lang>/<id>.webp`. |
| `designs: translate`                                                   | In `managed.json`, the design's slides in each language of the upload (`mergeTranslation`), and the pictures of them it brings.                                                                                                                                                                               |
| `designs: draw`                                                        | Adds the picture of each slide the galleries show that it brings, `images/designs/thumbs/320/<lang>/<id>.webp`, of any published design; it changes no slide. Each names the word of the slide it was drawn of, and is named by it while the slide still has it.                                              |
| `templates: translate`                                                 | `samples[<template>][<lang>]` spliced into `templates/catalog.json`, which changes in no other byte (`spliceSample`).                                                                                                                                                                                         |
| `<part>: tag` (designs, cards, frames, shapes, graphics, emoji, icons) | Merged into `tags/<part>.json`: each item the upload names takes its tags in every language given, and the others keep theirs (`mergeTags`).                                                                                                                                                                  |

An author's publication (`files.ts`) writes the files an author changed since the copy was pulled, and refuses every path the library changed meanwhile. That stays as it is, by an admin, or by a `publish` token.

Every publication, of uploads or of files, then writes what is made of the catalogs of the designs (`designFiles.ts`, ADR-109 of the app): each catalog in each language, `elements/designs/revs.json` (the word of each design in each language, of its slide and its pictures, what it was made from, and the designs of each catalog), and the word of each picture of a slide an upload brought in `images/designs/thumbs/index.json`: of the slide it brought, or for a drawing, of the slide it was drawn of, when that is the slide still (else the slide is drawn live). An app takes none of the first two when they are of another library. A catalog whose words `revs.json` holds as it is, with the pictures of its designs, is not read: the authored one is some 43 MB, read by the structure of its JSON when it must be. A publication that takes no upload writes them where they are of another library (**Try again**; `{"uploads": []}` takes none even while some wait, as Slidr Studio asks before it draws the pictures of the designs).

### 9.3 The manifest

As today (`encodeManifest`): the manifest read at the start, with the written files' entries put in or replaced, `published` set to now, the files in order, two spaces, and a final newline. It is written last, and only over the manifest the publication started from.

### 9.4 Writing, safely

- **Order.** The publication first keeps the manifest it read, and each file it replaces, in `media/history/<published>/`. Then it writes the new and changed files, and the manifest last.
- **The folder, which has no atomic write of its own.** Each file goes to a hidden temporary name in its own folder and is renamed into place, so neither Nginx nor any other reader ever sees half a file. This holds on a local file system only, which is why D13 refuses a network one.
- **Putting the media back.** If the publication fails before the manifest is written (an error, the store lost, the manifest changed meanwhile), it puts back every file it replaced, from the history, and removes every file it added. The media is then as it was.
- **The window.** Between a changed file and the new manifest, an app may meet a file whose hash the old manifest does not match. The app refuses such a file and reads it again later (docs/media-library.md, "How the app reads it"), so writing keeps that window to seconds. R2 serves each object whole, and Cloudflare's cache is emptied of every file written once the manifest is.

### 9.5 What is recorded

Each upload records when it was published and by whom, in its history. Each publication's answer (`Publication` of `publish.ts`: the uploads written and their paths, those skipped and why, the files added and changed) is kept as `media/publications/<published>.json`, apart from the history, so the publications are listed without reading it. The page's **Publications** view lists them for reviewers.

## 10. API

What changes in the routes. Everything not named here stays as the README describes it.

| Route                                                                                     | Who                                  | What                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`                                                                             | anyone                               | Which sign-in methods are offered; the person, their role, whether they are blocked, and what they may do.                                    |
| `GET /api/me/tokens`, `POST /api/me/tokens`                                               | session                              | Their tokens. `POST { name, scope?, days? }` answers the token once.                                                                          |
| `DELETE /api/me/tokens/{id}`                                                              | session                              | Revokes one of their tokens.                                                                                                                  |
| `GET /api/uploads`, `GET /api/uploads/{id}`                                               | token or session                     | An uploader sees only their own uploads, and a reviewer sees all. Views have no `path`.                                                       |
| `POST /api/uploads`, `PUT/DELETE …/languages/{lang}`, `DELETE /api/uploads/{id}`          | token or session (their own)         | As today, within the limits of §6.4.                                                                                                          |
| `POST /api/uploads/{id}/status`                                                           | session, reviewer                    | `accepted` (which also publishes it, and answers the publication), `rejected` or `pending`. `published` is refused.                           |
| `GET /api/library`                                                                        | token or session                     | Where the library is published (its public URL, not its store), when, its files and bytes, and how many uploads wait.                         |
| `POST /api/publish`                                                                       | session reviewer, or `publish` token | Publishes what waits, or the uploads named. This is also **Try again**.                                                                       |
| `POST /api/library/import`, `PUT /api/library/staged/{sha256}`, `POST /api/library/files` | session admin, or `publish` token    | Seeding an empty store, and an author's publication.                                                                                          |
| `GET /api/members`, `PUT /api/members/{email}`, `DELETE /api/members/{email}`             | session, admin                       | Members: `PUT { role: 'reviewer' \| 'admin' }`. Blocking is `PUT /api/people/{email} { blocked }`, which also lists and revokes their tokens. |
| `GET /api/settings`, `PUT /api/settings/{sign-in,limits}`                                 | session, admin                       | Settings without their keys (§5.3). The address and the media are only shown.                                                                 |
| `PUT /api/settings/sign-in/secret`                                                        | session, admin                       | Gives the client's secret. Write-only: answers `204`.                                                                                         |
| `POST /api/settings/media/test`                                                           | session, admin                       | Tests the store (§4.5).                                                                                                                       |
| `GET /media/{path}`                                                                       | anyone                               | The media (§4.6).                                                                                                                             |
| `GET /auth/local?code=`                                                                   | anyone with the code                 | The owner's one-time link of a local library (§6.2).                                                                                          |

- **Errors** keep their shape (`{ error, message, issues? }`). Codes: `token-scope`, `blocked`, `limit`, `not-a-reviewer`, `not-an-admin`, `owner`, `store-unreachable`.
- **OpenAPI** declares a `bearer` security scheme, with the scope each route needs, and a cookie scheme for the routes of the page.
- **Gone** (2026-10-26): `PUT /api/settings/media`, `PUT /api/settings/media/key`, `PUT /api/settings/library`, and the code `host-key-changed`. A local library's media is the install's (D13), and the central library's is its binding.
- **Gone** (2026-10-25): `LIBRARY_KEYS` and `key:<name>` actors (records that already hold them stay readable); the `publish` permission of editors, now split between reviewers and admins; `path` in upload views; `bucket` in `GET /api/library`, which names storage (D7). `LIBRARY_EDITORS` goes once it is imported (§13).

## 11. The page

The page's words are in Hebrew and English, and every other locale of `src/i18n`.

- **Account button → Profile:** the person's name, address, provider and role; their tokens (make, choose the scope, copy once, revoke); sign out.
- **Uploads:** an uploader sees "My uploads", and a reviewer sees all of them, with the review actions. Approving shows the publication that followed. An approved upload that waits shows why, and **Try again**. **Publish N accepted** stays, for reviewers.
- **Publications** (reviewers): the list of §9.5, and each publication up close.
- **Members** (admins): members by email and role, add by email, change a role, remove, block. The owner is marked and cannot be changed. Until OIDC is set, it says that the people added cannot sign in yet.
- **Settings** (admins): §5.3. The media shows where it is, its **Test** and the result (reached, read the manifest, wrote a probe file), the room left on a local library's disk, and **Seed**. It offers no choice of store, and no key of one.
- **First run** of a local library with no owner session: the page says to run `slidr-library login` on the machine.

## 12. Security

- **Keys** are sealed in the vault (§4.4), write-only, and never logged. The master key is in a file apart from the data folder, or in a secret, never beside the store.
- **Tokens** are kept as hashes. They are shown once, expire, and are revoked. A token's scope is checked against its owner's role on every request. The `slk_` prefix lets secret scanners find a leaked one.
- **Sessions:** a same-origin check on every change made with a session, a session key that can be renewed, and roles read on every request.
- **The owner's one-time link:** one use, 10 minutes, 256 bits, kept as a hash, made only on the machine by someone who may run Docker there (D17), and kept out of Nginx's log.
- **Network:** a local library's port is bound to `127.0.0.1` unless the installer chooses otherwise, and beyond the machine it speaks only HTTPS, its own or a proxy's. Node listens inside the container only. Nginx names no version (`server_tokens off`), and passes `X-Forwarded-*` from the proxy only.
- **The container:** not root, a read-only root file system, no capabilities, `no-new-privileges`; the image pinned by its digest, with its build provenance attested; the script's build attested too (`gh attestation verify`, which `update` runs where GitHub's CLI is), since the SHA-256 published beside it, from the same release, only finds a download that went wrong. The container runs as an account of the machine made for it (`slidr-library`), so that no other account shares the user id its folders and keys belong to. In the proxy way, Nginx answers the proxy alone.
- **The media at `/media/`:** only paths `isLibraryPath` accepts, no listing, no link followed, and `Content-Security-Policy: sandbox`, so no file of the media runs at the library's origin.
- **Paths:** media paths come only from the upload handlers, from an author's publication (checked by `isLibraryPath`), and from the media's own manifest. No path climbs out of the folder: it is checked again after resolving, and links are not followed. The media folder is never the data or keys folder, inside either, or holding either.
- **Open uploading:** the limits of §6.4, blocking, allowed domains, and a check of every byte before anything is kept.
- **Audit:** it records:
  - members, roles and blocking;
  - settings, and keys (that they were set, never the value);
  - tokens made and revoked;
  - sign-ins of the owner by one-time link;
  - approvals and publications.

## 13. Moving from today's deployment

1. At the first start of the new version on Cloudflare, `LIBRARY_OWNER` becomes the owner, and each address in `LIBRARY_EDITORS` becomes a reviewer. The audit records both. The variables may then be removed.
2. The bucket `MEDIA` stays the media store, and holds the library only. It never held `_…` keys: it was empty until the library was brought in on 2026-10-25, by `main` (4e2bef5), which keeps the bookkeeping beside the uploads, under `media/history/`, `media/staged/` and `media/lock.json`. The state store takes those keys over as they are.
3. Programs moved from program keys to a person's token on 2026-10-25, and `LIBRARY_KEYS` was taken away with it:
   - the studio, as `SLIDR_LIBRARY_TOKEN` or in its keychain (`library-token`), and `import-library.mjs`, as `LIBRARY_TOKEN`, take an admin's `publish` token, since they publish;
   - the app's `tag-elements.mjs --upload`, as `LIBRARY_TOKEN`, takes an `upload` token.
4. media.slidr.studio moved from the Pages project `slidr-media` to the bucket's own domain (`main`, 4e2bef5; README, "Serving the library"), and was set up on Cloudflare on 2026-10-25. Nothing of it is left to this work.
5. No local library was installed before 2026-10-26, other than for tests, so taking SFTP, FTP, R2 from a machine and the keychain away leaves nothing to move. A data folder of `pnpm library init` can be given to the script as its data folder; its master key is then written into the keys folder by hand.
6. The studio's README and the app's `docs/media-library.md` say what changed: approval publishes, tokens replace keys, and an organization can install a local library, in Docker on Linux. These are changes in the other repositories, made with this work.

## 14. Out of scope

- Taking items out of the media, or undoing a publication after it succeeded. The history keeps what is needed to do it by hand.
- New kinds of upload, or uploading raw media files (fonts, icons, images) that no handler takes ([§15](#15-open-questions)).
- A local library on Windows or macOS, or on Linux outside Docker. Running it from the source is for the tests and for working on the code only.
- Podman, rootless Docker, Kubernetes and Docker Swarm.
- A local library's media anywhere but a folder of the machine's own disks: SFTP, FTP, R2, Pages, NFS, SMB.
- More than one container, or process, over one data folder.
- A cache or a CDN before a local library's `/media/`.
- Moving the media from one store to another, beyond seeding an empty store from a published library.

## 15. Open questions

1. **Manual upload.** What the manual upload lacks, if anything (D4). The user will look again.
2. **Approving one's own upload.** Allowed for now, so that a single installer can work alone. Should a setting require a second person?
3. **Microsoft and verified addresses.** Entra ID does not send `email_verified`. Settled: the Microsoft preset is held to one tenant (its id or its domain, never `organizations` or `common`), and accepts an address only when allowed domains are set, so that tenant vouches for it.
4. **Is `/media/` public?** Yes, as the published library is. Should an organization be able to close it?
5. **Following the central library.** A local library is seeded once, from media.slidr.studio, and then holds only what its own reviewers approve. Should it take in what the central library publishes later (by hand, or on a schedule), and which wins when both changed the same file?
