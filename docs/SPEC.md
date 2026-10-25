# Slidr Library — specification

Status: **approved 2026-10-25**, then rebased onto `main` at 4e2bef5, which already publishes into the library's bucket and serves it straight from R2. Companion: [implementation plan](PLAN.md). This document describes where the library is going; the [README](../README.md) describes what it does today. Paths such as `desktop/…` and `packages/…` are of the app's repository, copied into `vendor/`.

## 1. Purpose

The library is the way in to the media library (`docs/media-library.md` of the app): people **view** it, and **manage** it. Content enters by an **upload**, through the REST API or by hand on the page. Each upload waits for **review**. When a reviewer approves it, **the library itself writes it into the media**, where every installed app reads it.

| #   | Requirement (2026-10-25)                                                                                                                                                                                   | Where                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R0  | The library writes approved content into the media.                                                                                                                                                        | [§9](#9-writing-approved-content-into-the-media)                  |
| R1  | The library stands on its own, and can be installed locally. Its media may be a local folder, a server reached by FTP or SSH, or Cloudflare Pages. Each one takes a key that grants access, kept securely. | [§4](#4-architecture), [§5](#5-installation-r1)                   |
| R2  | How the library stores files is its own business, and has nothing to do with the API.                                                                                                                      | [§4.3](#43-state-store), [§4.5](#45-media-stores), [§10](#10-api) |
| R3  | A person makes a token in their profile. The token, in a header, is all an upload needs.                                                                                                                   | [§7](#7-tokens-r3)                                                |
| R4  | The library manages who may review, that is, approve uploads into the media. The installer is the first, and adds more people by email.                                                                    | [§6](#6-people-and-permissions-r4)                                |

## 2. Today, and what changes

`main` (4e2bef5) already keeps the published library in an R2 bucket of the Worker (`MEDIA`, `slidr-media`; `worker/media/live.ts`). media.slidr.studio is that bucket itself, a custom domain of R2 with Cloudflare's cache before it, so no Worker runs when an app reads the library; the Worker serves the same bucket at `/media/` (`serve.ts`), as a dev server does. A **publication** (`publish.ts`, `merge.ts`) writes the accepted uploads into the bucket:

- it checks each upload again, and keeps what it replaces beside the uploads (`media/history/`);
- it writes the manifest last, over the one it read;
- it holds a lock while it runs (`media/lock.json`, beside the uploads);
- it then empties Cloudflare's cache of the files it wrote, and of the manifest (`cache.ts`).

An author's generator output reaches the bucket through the API as well (`files.ts`, used by the app's `pnpm media:publish`), and the library came into the bucket once from the site (`import.ts`).

| Today (`main`)                                                                                                                     | Becomes                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One host: a Cloudflare Worker (`worker/`). Uploads are kept in R2 (`UPLOADS`), and the media in R2 (`MEDIA`).                      | One core with two hosts: a Node server installed on a machine, and the Cloudflare Worker.                                                                                                           |
| The media is an R2 bucket bound to the Worker. Nothing else can hold it.                                                           | The media is a **media store** that the installer chooses: a local folder, SFTP, FTP, or Cloudflare (an R2 bucket served by a Pages project). The publication code runs unchanged over any of them. |
| The library's own bookkeeping (`_history/`, `_staged/`, `_publishing.json`) lives in the media bucket, beside the library's files. | The bookkeeping moves to the library's state store. A media store holds the library's files and its manifest, and nothing else.                                                                     |
| A publication runs when an editor presses **Publish N accepted** or calls `POST /api/publish`.                                     | Approving an upload publishes it right away. A sweep picks up whatever could not be written then.                                                                                                   |
| Who may upload, review and publish: Google accounts in `LIBRARY_EDITORS`, a secret of the Worker.                                  | Anyone who signs in may upload. Who may review is a list of **members** that the library keeps and admins edit.                                                                                     |
| Programs (the studio, the app's `media:publish`, `import-library.mjs`) use keys named in `LIBRARY_KEYS`.                           | Each person makes their own **tokens** in their profile. `LIBRARY_KEYS` goes away.                                                                                                                  |
| Sign-in: Google only, with a client set in Worker secrets.                                                                         | The owner signs in by a one-time local link. Everyone else signs in through OIDC, with Google as the default.                                                                                       |
| The page reads the media from `media.slidr.studio` (`MEDIA_LIBRARY_URL`).                                                          | The page reads it from its own library's `/media/`.                                                                                                                                                 |

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Anyone who signs in may make tokens and upload.** Uploads wait for review, and only members review. Admins can limit sign-in to email domains, block a person, and cap what each person keeps waiting.                                                                                                                                                                                                                    | The user's choice. Since uploading is open, the library needs the limits and the block list ([§6.4](#64-open-uploading-and-its-limits)).                                                                                                  |
| D2  | **Sign-in: a one-time local link for the owner, plus OIDC for everyone.** OIDC comes with presets for Google (the default) and Microsoft, and takes any issuer.                                                                                                                                                                                                                                                             | The user's choice. A local install works with no setup at all for its installer. Adding people by email needs a provider that vouches for their addresses, and a closed network can use its own (Entra, Keycloak).                        |
| D3  | **Approval writes to the media immediately**, through today's publication. One publication runs at a time. An upload approved while one runs is written by the sweep (every minute). A write that fails leaves the upload approved, with the error, and it is tried again.                                                                                                                                                  | The user's choice. The publication code of `main` stays as it is: approving calls it for the one upload.                                                                                                                                  |
| D4  | **Manual upload stays as it is** (Uploads → New upload) until the user says what it lacks.                                                                                                                                                                                                                                                                                                                                  | The user will check it again ([§15](#15-open-questions)).                                                                                                                                                                                 |
| D5  | **One core, two hosts.** The core is web-standard (`Request` → `Response`, `crypto.subtle`), as `worker/` is today. Each host gives it a state store, a vault and a media store.                                                                                                                                                                                                                                            | The Worker keeps working as it does, and the local install runs the very same code.                                                                                                                                                       |
| D6  | **Every key is kept encrypted in a vault** (AES-256-GCM). The master key lives outside the store: in the OS keychain on a machine, and in a Worker secret on Cloudflare. A key is write-only: no route returns it, and it is never logged.                                                                                                                                                                                  | R1 ("store it securely"). A copied data folder, a backup, or a leaked bucket reveals no key.                                                                                                                                              |
| D7  | **The API speaks of the published library, never of its storage.** Routes name uploads, items, languages and the paths of the library's own manifest, which `/media/` publishes anyway. No route names a store, a bucket, a folder, a server, or a key of the library's bookkeeping (`_history`, `_staged`, the lock), and no answer reveals any of them. Upload views lose `path`, which is the library's to decide.       | R2. A target can change without a change to any client.                                                                                                                                                                                   |
| D8  | **A token has a scope.** `upload` is the default, open to everyone: make, read, change and withdraw one's own uploads. `publish` is open to admins only: write an author's files, import, and run the publication of uploads already approved. **Approving and administering need a session** on the library's page.                                                                                                        | R3 says a token is for uploading. The app's `pnpm media:publish`, the studio and `import-library.mjs` are programs that write into the media without review today, so they need the `publish` scope, while approval stays a person's act. |
| D9  | **The library serves its media at `/media/`**, as `serve.ts` does today, over whatever store holds it. The page always reads the media there. On a machine, it is also an address the app may read (ADR-107 of the app).                                                                                                                                                                                                    | A local folder has no web server, and the page should show the library it manages.                                                                                                                                                        |
| D10 | **Cloudflare's media is the R2 bucket under its own domain, with Cloudflare's cache before it** (`main`, 4e2bef5; this replaced a Pages site in front of the bucket). No Worker runs when an app reads the library, and a publication empties the cache of what it wrote (`media/cache.ts`), with the zone's purge token. A library on a machine writes the bucket through R2's S3 API, and empties the cache the same way. | Reading the library costs nothing per request. Pages deployments would bring their 25 MiB file limit, catalog splitting, and an asset-hash API that wrangler keeps to itself.                                                             |
| D11 | **The bookkeeping lives in the state store, not in the media** (done on `main`, 4e2bef5). This covers the history of each publication, the files staged for an author's publication, and the lock. The `_…` keys already in the bucket stay readable, and new ones are not written there.                                                                                                                                   | R2. A folder or a server that a web server publishes as it is must not publish the library's bookkeeping too.                                                                                                                             |

## 4. Architecture

```text
   the page (React)          REST clients (studio, app's media:publish, scripts)
          │  cookie session            │  Authorization: Bearer slk_…
          ▼                            ▼
 ┌────────────────────── host ───────────────────────┐
 │  Node server (local install)  |  Cloudflare Worker  │
 └──────────────────────┬─────────────────────────────┘
                        ▼
 core: /auth  /api/me  /api/uploads  /api/library  /api/publish  /api/members  /api/settings  /media/
                        │
     ┌──────────────────┼────────────────────┬──────────────────────────────┐
     ▼                  ▼                    ▼                              ▼
 State store          Vault               Media store                    Jobs
 Node: a folder       AES-256-GCM         folder | sftp | ftp | r2        the sweep (each minute),
 Worker: R2           master key from     (binding on the Worker,         rejected uploads cleared
 (UPLOADS)            keychain / secret    S3 API on a machine)

                                           r2 ──► its own domain, Cloudflare's cache ──► installed apps
```

### 4.1 Core

The core is `worker/` today, moved to `server/core/` and kept free of any host: it uses only the web's APIs. Every route is a function `(request, ctx) → Response`. `ctx` carries the ports below, the configuration, the client's address and the person making the request. The core holds:

- the routes;
- the upload handlers (`designs.ts`, `templates.ts`, `tags.ts`) and their checks;
- the publication (`publish.ts`, `merge.ts`, `files.ts`, `import.ts`, `serve.ts`);
- the roles and the tokens.

### 4.2 Hosts

| Host                                      | Runs as                                                                                             | State store                 | Master key                                                                                             | Media stores                       | Jobs                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------- |
| **Node** (`server/host/node`)             | One process: the built page (`dist/client`), the API and `/media/`, on `127.0.0.1:5176` by default. | A folder in the data folder | The OS keychain (Windows Credential Manager, macOS Keychain, Secret Service), or `LIBRARY_MASTER_KEY`. | folder, sftp, ftp, r2 (S3 API)     | A timer in the process |
| **Cloudflare** (`server/host/cloudflare`) | The Worker `library`, as today.                                                                     | R2 (`UPLOADS`, as today)    | The Worker secret `LIBRARY_MASTER_KEY`.                                                                | r2 (the binding `MEDIA`, as today) | A Cron Trigger         |

A Worker cannot reach a local folder, and it has no SSH or FTP client, so Settings on the Cloudflare host offers only R2.

### 4.3 State store

The state store holds everything the library keeps for itself:

- uploads and their files, until they are written;
- people, tokens and settings;
- sealed keys;
- the bookkeeping of its publications.

Its interface is today's `Bucket` (get, put with `onlyIf.etagMatches`, delete, list by prefix with metadata), so R2 serves it as it is. On Node it is a folder:

- one file per key, written to a temporary name and renamed into place;
- a sidecar for the metadata;
- the etag is the content's SHA-256;
- a lock inside the process makes put-if-match atomic (there is one server process per data folder).

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
  - Node: the OS keychain, as the service `Slidr Library` and the account `<absolute data folder>`. Where no keychain exists (a server with no Secret Service), the environment variable `LIBRARY_MASTER_KEY` holds it. A key file is used only when `--master-key-file <path>` names it, and the Settings page warns about it.
  - Cloudflare: the Worker secret `LIBRARY_MASTER_KEY`.
- `kid` names the master key. `slidr-library vault rotate` seals every key again under a new master key.
- The keys: `media` (the media store's key, below), `oidc` (the OIDC client's secret) and `session` (the key that signs cookies, made at install).
- A key is write-only. Settings shows only whether it is set, when and by whom, and for an SSH key its public fingerprint. Logs, errors and the audit never hold a key, nor a token.

### 4.5 Media stores

The publication code of `main` (`live.ts`, `publish.ts`, `files.ts`, `import.ts`, `serve.ts`) reads and writes the media through the `Bucket` it is given. That interface becomes a port of its own, `MediaStore`. It is the part of `Bucket` this code uses: read a file (its bytes, size and SHA-256), write a file with its SHA-256 and type, remove a file, list the files with their SHA-256, and write the manifest over the one read (`etagMatches`). Each target implements it:

| Store               | Settings                                                                                                                                                   | Key (in the vault)                                                                                                                                                                                                                 | Reads and writes                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local folder**    | Absolute path; public URL (optional)                                                                                                                       | None. Access is the server account's permission on the folder, and Settings says so.                                                                                                                                               | From the folder, and into it: a temporary name, then a rename. A file's SHA-256 comes from the manifest. The manifest's etag is its own SHA-256.                                                                                                                        |
| **SFTP (SSH)**      | Host, port (22), user, root folder, host key fingerprint (`SHA256:…`), public URL                                                                          | A private key (OpenSSH or PEM; Ed25519, ECDSA or RSA) with its passphrase, or a password                                                                                                                                           | Over SFTP: a temporary name, then a rename. Reads keep a cache in the data folder by SHA-256.                                                                                                                                                                           |
| **FTP**             | Host, port, user, root folder, TLS (explicit FTPS by default, or implicit), public URL                                                                     | A password                                                                                                                                                                                                                         | Over FTP(S): a temporary name, then a rename. Reads keep a cache in the data folder by SHA-256.                                                                                                                                                                         |
| **Cloudflare (R2)** | Cloudflare host: the binding `MEDIA`, and the zone's id. Node host: account ID, bucket, the bucket's domain (`https://media.example.org/`), the zone's id. | Cloudflare host: the zone's purge token (`MEDIA_PURGE_TOKEN`). Node host: an R2 API token's S3 credentials (Access Key ID and Secret Access Key), limited to _Object Read & Write_ on that one bucket, and the zone's purge token. | The binding on the Cloudflare host, as today. R2's S3 API on a machine, signed with SigV4 (`aws4fetch`, which needs no Node). Apps read the bucket at its own domain, through Cloudflare's cache, which a publication empties of what it wrote (`media/cache.ts`; D10). |

- **The host's key.** The library pins the SSH host key. The first **Test** shows the fingerprint, and an admin confirms it. A changed host key stops every write until an admin confirms the new one.
- **Plain FTP.** It sends the password in clear, so it is refused unless the admin ticks "allow unencrypted FTP". The page then says so wherever the store is named.
- **The manifest over SFTP and FTP.** These servers have no etag. The library's lease (§4.7) keeps any other publication out. Just before writing, the library reads the manifest again and compares its SHA-256 with the one it started from, so that a change made outside the library is not written over.
- **Public URL.** This is the address installed apps are given:
  - for SFTP and FTP, the HTTPS address where that server serves the folder;
  - for a local folder, the library's own `/media/` unless another is given;
  - for Cloudflare, the bucket's own domain.

  It must answer 404 for a missing file (docs/media-library.md, "A library of your own").

- **Test** reaches the store with its key, reads the manifest, and writes and removes a probe file (`.slidr-library-probe`), which is never part of the library.
- **An empty store** is seeded from a published library by today's import (`import.ts`), which copies every file checked against its manifest and writes the manifest last. The source is media.slidr.studio by default, or any address.

### 4.6 The media at `/media/`

`GET`/`HEAD /media/<path>` is today's `serveMedia` over the media store. It answers:

- the right type, and the file's SHA-256 as its `ETag`, with `304` to a reader that has it;
- 404 for a missing file;
- `Cache-Control: no-cache` on `manifest.json`;
- `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff`;
- only paths of the library (`isLibraryPath`).

The page is built with `__SLIDR_MEDIA_PATH__ = '/media/'`, so the app's readers in `vendor/` read the media there, and `src/media.ts` stops naming `MEDIA_LIBRARY_URL`. The upload checks read the store (`libraryIn`), as they read the bucket today.

Reading the media is public, as the published library is today. Only managing it needs a person.

### 4.7 Jobs

- **The lease.** One publication or author's publication runs at a time. It holds `media/lock.json` in the state store (10 minutes, as `_publishing.json` does today). The lock is taken with put-if-match, so two never take it together.
- **The sweep.** Each minute it publishes the uploads that are approved and not yet written, oldest first, up to 50, as `POST /api/publish` does today. It skips an upload that is waiting before its next try (§8). It runs from a timer of the process on Node, and from a Cron Trigger on Cloudflare.
- **Clearing.** Once a day, rejected uploads older than 30 days are removed, and the history of publications is kept to the last 100.

## 5. Installation (R1)

### 5.1 On a machine (Node)

The library is run from the repository, which is already self-contained through `vendor/`. A package or an image is for later ([§14](#14-out-of-scope)).

```powershell
pnpm install; pnpm build
pnpm library init        # asks: data folder, owner's email, media store, its key, seeding
pnpm library start       # http://127.0.0.1:5176
pnpm library login       # prints a one-time sign-in link for the owner
```

- **`init`** asks for every setting, or takes them as options so an install can run without anyone at the keyboard: `--data`, `--owner`, `--media folder|sftp|ftp|r2` and its fields, `--seed [<address>]`. A key is read from a hidden prompt or from standard input, never from a command-line option, so it stays out of the shell's history. `init` makes the master key and the session key, tests the store, and seeds it when asked. The person who runs it is the **owner** ([§6](#6-people-and-permissions-r4)).
- **The data folder** defaults to `%LOCALAPPDATA%\Slidr Library` on Windows, `~/Library/Application Support/Slidr Library` on macOS, and `~/.local/share/slidr-library` elsewhere. On Windows its ACL grants access to the installing user only, and elsewhere its mode is 0700.
- **`start`** listens on `127.0.0.1` only. To be reached from other machines it takes `--host <address>` with either `--tls-cert`/`--tls-key`, or `--behind-proxy` (it then trusts `X-Forwarded-Proto`). Either way the library's own URL (`url` in its settings) must be set: OIDC's redirect and the same-origin check both use it.
- **`login`** writes a one-time code (§6.2) and prints `http://127.0.0.1:5176/auth/local?code=…`.
- Other commands: `media test`, `media key` (gives the store a new key), `vault rotate`, `owner <email>` (hands ownership over, from the machine itself, for an owner who has lost access).

### 5.2 On Cloudflare

This is today's deployment, plus two things:

- **The secret `LIBRARY_MASTER_KEY`.**
- **A first owner.** The secret `LIBRARY_OWNER` names the owner once, at the first start, and after that the store is the truth. There is no local link on Cloudflare, so the owner signs in through OIDC. Until OIDC is set, the Google client of today's secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) serves as its Google preset.

The media store is the bucket `MEDIA`, as today.

### 5.3 Settings

The Settings page is for admins. It keeps its values in `config/library.json` and the vault:

- **Library:** its URL (the address it is reached at, on a machine behind a proxy).
- **Media:**
  - the kind of store, its fields, and its key (write-only);
  - **Test**;
  - **Seed**, for an empty store;
  - the public URL that installed apps are given, with the line to give them: the policy, or `/MEDIA=` of the installer, from docs/media-library.md.
- **Sign-in:**
  - the OIDC provider: Google, Microsoft, or another issuer;
  - its client ID and secret;
  - the redirect URI to register with the provider (`<url>/auth/callback`);
  - the domains whose addresses may sign in (empty: any).
- **Uploads:** the limits of §6.4.

Each change is tested before it is kept: a store is reached, and a provider's discovery document is read. Every change goes into the audit.

## 6. People and permissions (R4)

### 6.1 Roles

| Can                                                                                                        | Anyone | Signed in | Reviewer | Admin | Owner |
| ---------------------------------------------------------------------------------------------------------- | :----: | :-------: | :------: | :---: | :---: |
| See the library, read `/media/`, read the API's description                                                |   ✓    |     ✓     |    ✓     |   ✓   |   ✓   |
| Make and revoke their own tokens (`upload`); upload; change and withdraw their own uploads while they wait |        |     ✓     |    ✓     |   ✓   |   ✓   |
| See every upload; approve, reject, send back; publish what waits; **Try again**                            |        |           |    ✓     |   ✓   |   ✓   |
| Tokens with the `publish` scope; an author's publication; import                                           |        |           |          |   ✓   |   ✓   |
| Add and remove reviewers and admins; block people; revoke any token                                        |        |           |          |   ✓   |   ✓   |
| Settings: the media and its key, sign-in, limits                                                           |        |           |          |   ✓   |   ✓   |
| Hand ownership to another member                                                                           |        |           |          |       |   ✓   |

- The **owner** is the installer, and there is exactly one. No one removes the owner or changes the owner's role. The owner hands ownership over in Settings, or from the machine (`pnpm library owner <email>`).
- **Members** are people with a role. An admin adds one **by email** with a role (reviewer or admin), before or after that person has ever signed in. The role takes effect at their next request, because roles are read from the store on every request, never from the session. Removing a member, or changing their role, takes effect at once. A `publish` token whose owner is no longer an admin stops working at once.
- **A person who signs in** without a role is an uploader. They see their own uploads only.
- A reviewer may approve their own upload. The upload's history records who uploaded it and who approved it ([§15](#15-open-questions)).

### 6.2 Signing in

- **OIDC.** This is today's authorization code flow, with PKCE, `state` and `nonce` (`worker/auth.ts`), made generic: the endpoints come from the issuer's discovery document. Google is the default issuer, and Microsoft (`login.microsoftonline.com/<tenant>/v2.0`) is a preset. The ID token comes straight from the token endpoint, so its issuer, audience, expiry and nonce are checked, as today. The address must be verified (`email_verified`), and must be in an allowed domain when domains are set.
- **The owner's local link** (Node only). `pnpm library login` makes a 32-byte code and keeps only its hash, for 10 minutes and one use. `/auth/local?code=` accepts it only from a loopback address, then signs in the owner. This is how a local install's owner signs in with no provider at all. Others need OIDC, and the Members page says so until it is set.
- **The session** is today's: an `HttpOnly` cookie, `SameSite=Lax`, `Secure` with the `__Host-` prefix over HTTPS, signed with the `session` key, for 14 days. It holds who the person is (email, name, provider), not what they may do. A request that changes something, sent with a session, must come from the library's own origin, as today. **Sign everyone out** (Settings) makes a new `session` key.

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
- **An upload that no longer holds** when it is written (someone took its id meanwhile) goes back to `pending`, with a note that says why, so its uploader can fix it. `main` leaves it accepted. The rest of the publication goes on without it.
- **Marked published by hand.** This already answers `409 publish-instead` once the library is live. The way back from `published` to `accepted` goes away with it.

## 9. Writing approved content into the media

### 9.1 A publication

The publication is `main`'s `publish.ts`, with three changes:

- it runs over the media store, with its bookkeeping in the state store (D11);
- approving and the sweep start it;
- a failure part-way puts the media back as it was (§9.4).

It takes the uploads named, or every accepted one, oldest first, up to 50. It reads what it changes from the store as it is now, checks each upload again, applies each (`merge.ts`), and writes.

### 9.2 What each upload changes

These are `merge.ts` on `main`, unchanged:

| Upload                                                                 | Changes in the media                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `designs: add`                                                         | Adds `images/designs/<id>.webp` (and `<id>-bg.webp`). In `elements/designs/managed.json` (written compact) it sets the design's names, group, slides, subject, size and tags (`mergeDesign`). |
| `designs: translate`                                                   | In `managed.json`, the design's slides in each language of the upload (`mergeTranslation`).                                                                                                   |
| `templates: translate`                                                 | `samples[<template>][<lang>]` spliced into `templates/catalog.json`, which changes in no other byte (`spliceSample`).                                                                         |
| `<part>: tag` (designs, cards, frames, shapes, graphics, emoji, icons) | Merged into `tags/<part>.json`: each item the upload names takes its tags in every language given, and the others keep theirs (`mergeTags`).                                                  |

An author's publication (`files.ts`) writes the files an author changed since the copy was pulled, and refuses every path the library changed meanwhile. That stays as it is, by an admin, or by a `publish` token.

### 9.3 The manifest

As today (`encodeManifest`): the manifest read at the start, with the written files' entries put in or replaced, `published` set to now, the files in order, two spaces, and a final newline. It is written last, and only over the manifest the publication started from.

### 9.4 Writing, safely

- **Order.** The publication first keeps the manifest it read, and each file it replaces, in `media/history/<published>/` (as `_history/` today). Then it writes the new and changed files, and the manifest last.
- **A store without atomic writes** (folder, SFTP, FTP). Each file goes to a temporary name in its own folder and is renamed into place, so no reader ever sees half a file.
- **Putting the media back.** If the publication fails before the manifest is written (an error, the store lost, the manifest changed meanwhile), it puts back every file it replaced, from the history, and removes every file it added. The media is then as it was. `main` leaves them written, under the old manifest.
- **The window.** Between a changed file and the new manifest, an app may meet a file whose hash the old manifest does not match. The app refuses such a file and reads it again later (docs/media-library.md, "How the app reads it"), so writing keeps that window to seconds. R2 serves each object whole, and Cloudflare's cache is emptied of every file written once the manifest is.

### 9.5 What is recorded

Each upload records when it was published and by whom, in its history, as today. Each publication's answer (`Publication` of `publish.ts`: the uploads written and their paths, those skipped and why, the files added and changed) is kept as `media/history/<published>/publication.json`. The page's **Publications** view lists them for reviewers.

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
| `GET /api/library`                                                                        | token or session                     | As today: where the library is published (its public URL, not its store), when, its files and bytes, and how many uploads wait.               |
| `POST /api/publish`                                                                       | session reviewer, or `publish` token | As today: publishes what waits, or the uploads named. This is also **Try again**.                                                             |
| `POST /api/library/import`, `PUT /api/library/staged/{sha256}`, `POST /api/library/files` | session admin, or `publish` token    | As today: seeding an empty store, and an author's publication.                                                                                |
| `GET /api/members`, `PUT /api/members/{email}`, `DELETE /api/members/{email}`             | session, admin                       | Members: `PUT { role: 'reviewer' \| 'admin' }`. Blocking is `PUT /api/people/{email} { blocked }`, which also lists and revokes their tokens. |
| `GET /api/settings`, `PUT /api/settings/{media,sign-in,uploads,library}`                  | session, admin                       | Settings without their keys (§5.3).                                                                                                           |
| `PUT /api/settings/media/key`, `PUT /api/settings/sign-in/secret`                         | session, admin                       | Gives a key. Write-only: answers `204`.                                                                                                       |
| `POST /api/settings/media/test`                                                           | session, admin                       | Tests the store, and answers the SSH host key to confirm.                                                                                     |
| `GET /media/{path}`                                                                       | anyone                               | The media (§4.6).                                                                                                                             |
| `GET /auth/local?code=`                                                                   | loopback                             | The owner's local link (§6.2).                                                                                                                |

- **Errors** keep today's shape (`{ error, message, issues? }`). New codes: `token-scope`, `blocked`, `limit`, `not-a-reviewer`, `not-an-admin`, `owner`, `store-unreachable`, `host-key-changed`.
- **OpenAPI** declares a `bearer` security scheme, with the scope each route needs, and a cookie scheme for the routes of the page.
- **Gone:**
  - `LIBRARY_KEYS` and `key:<name>` actors (records that already hold them stay readable);
  - `LIBRARY_EDITORS`, imported once (§13);
  - the `publish` permission of editors, now split between reviewers and admins;
  - `path` in upload views;
  - `bucket` in `GET /api/library`, which names storage (D7).

## 11. The page

The page's words are in Hebrew and English, and every other locale of `src/i18n`.

- **Account button → Profile:** the person's name, address, provider and role; their tokens (make, choose the scope, copy once, revoke); sign out.
- **Uploads:** as today. An uploader sees "My uploads", and a reviewer sees all of them, with the review actions. Approving shows the publication that followed. An approved upload that waits shows why, and **Try again**. **Publish N accepted** stays, for reviewers.
- **Publications** (reviewers): the list of §9.5, and each publication up close.
- **Members** (admins): members by email and role, add by email, change a role, remove, block. The owner is marked and cannot be changed. Until OIDC is set, it says that the people added cannot sign in yet.
- **Settings** (admins): §5.3. It shows the store's **Test** and its result (reached, signed in, read the manifest, wrote a probe file), the SSH host key to confirm, **Seed**, and the key fields, which never show what they hold.
- **First run** of a local install with no owner session: the page says to run `pnpm library login`.

## 12. Security

- **Keys** are sealed in the vault (§4.4), write-only, and never logged. The master key is in the keychain, or in a secret, never beside the store.
- **Tokens** are kept as hashes. They are shown once, expire, and are revoked. A token's scope is checked against its owner's role on every request. The `slk_` prefix lets secret scanners find a leaked one.
- **Sessions:** today's cookie, a same-origin check on every change made with a session, a session key that can be renewed, and roles read on every request.
- **The local link:** one use, 10 minutes, loopback only, kept as a hash.
- **Network:** listens on loopback by default. Beyond that, only with TLS or behind a proxy. SFTP pins its host key. FTP uses TLS unless the admin explicitly allows it without.
- **Paths:** media paths come only from the upload handlers, from an author's publication (checked by `isLibraryPath`), and from the media's own manifest. A store's root folder is fixed in Settings, and no path climbs out of it: it is checked again after resolving, and links are not followed.
- **Open uploading:** the limits of §6.4, blocking, allowed domains, and a check of every byte (as today) before anything is kept.
- **Audit:** it records:
  - members, roles and blocking;
  - settings, and keys (that they were set, never the value);
  - tokens made and revoked;
  - sign-ins of the owner by local link;
  - approvals and publications.

## 13. Moving from today's deployment

1. At the first start of the new version on Cloudflare, `LIBRARY_OWNER` becomes the owner, and each address in `LIBRARY_EDITORS` becomes a reviewer. The audit records both. The variables may then be removed.
2. The bucket `MEDIA` stays the media store. Its `_history/` and `_staged/` stay where they are, and are read where needed; new bookkeeping goes to the state store. `_publishing.json` is honoured once (a publication that is running finishes), then no longer written.
3. Programs move from program keys to a person's token:
   - the app's `pnpm media:publish` (`LIBRARY_KEY`) and `import-library.mjs` take an admin's `publish` token;
   - the studio (`SLIDR_LIBRARY_KEY`) takes an `upload` token, or a `publish` one if it should still press publish;
   - `tag-elements.mjs --upload` (`LIBRARY_KEY`) takes an `upload` token.

   All of them already send `Authorization: Bearer`, so only their documentation and settings change. `LIBRARY_KEYS` stops working in the release after that.

4. media.slidr.studio moves from the Pages project `slidr-media` to the bucket's own domain (`main`, 4e2bef5; README, "Serving the library"). Those steps on Cloudflare are the user's.
5. The studio's README and the app's `docs/media-library.md` say what changed: approval publishes, tokens replace keys, and an organization can install its own library. These are changes in the other repositories, made with this work.

## 14. Out of scope

- Taking items out of the media, or undoing a publication after it succeeded. The history keeps what is needed to do it by hand.
- New kinds of upload, or uploading raw media files (fonts, icons, images) that no handler takes ([§15](#15-open-questions)).
- Pages deployments as a store (D10).
- An npm package, a Docker image, and running as a Windows service or under systemd. The documentation covers running it under Task Scheduler or NSSM.
- More than one server process over one data folder.
- Moving the media from one store to another, beyond seeding an empty store from a published library.

## 15. Open questions

1. **Manual upload.** What the manual upload lacks, if anything (D4). The user will look again.
2. **Approving one's own upload.** Allowed for now, so that a single installer can work alone. Should a setting require a second person?
3. **Microsoft and verified addresses.** Entra ID does not send `email_verified`. Should the Microsoft preset accept the address only when allowed domains are set (so the tenant vouches for it)?
4. **Is `/media/` public?** Yes, as the published library is today. Should an organization be able to close it, with apps reading the media through the store's own address instead?
