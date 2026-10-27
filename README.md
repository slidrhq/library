# Slidr Library

The way in to the media library (docs/media-library.md of the app): a web page that shows it as every installed app reads it, and the server that manages it. People sign in ([Signing in](#signing-in)), upload content by the page or by the API with a token of their own ([Uploading](#uploading)), and a reviewer's approval writes it into the media at once ([Publishing the uploads](#publishing-the-uploads)). The central library is the Worker on Cloudflare, library.slidr.workers.dev, its media at media.slidr.studio; an organization may install a library of its own on Linux, in Docker ([A local library](#a-local-library)). [docs/SPEC.md](docs/SPEC.md) is what it does and why, and [docs/PLAN.md](docs/PLAN.md) how it was built.

## Setup

```powershell
pnpm install
pnpm dev               # http://127.0.0.1:5176, with the Worker
pnpm test              # the Worker's tests
pnpm build; pnpm preview
```

`pnpm dev` and `pnpm preview` run the Worker inside Vite (`@cloudflare/vite-plugin`, in Cloudflare's own runtime), with the secrets of `.dev.vars`. Without that file the page works the same, and offers no signing in.

## A local library

An organization may run a library of its own, without Cloudflare, on a Linux machine of its own ([docs/SPEC.md](docs/SPEC.md) §5): the same server the Worker runs (`server/core`), on Node (`server/host/node`), with its media in a folder of that machine's own disks. It is one Docker image, `ghcr.io/slidrhq/library`, with Nginx at its door (`docker/`), installed by a script that asks for the media folder and little else (`install/install.sh`). The central library, library.slidr.workers.dev, stays the Worker on Cloudflare.

### Installing it

On Linux (x86-64 or ARM64), with Docker Engine 24 or later and its compose plugin:

```sh
curl -fsSLO https://github.com/slidrhq/library/releases/latest/download/install.sh
curl -fsSLO https://github.com/slidrhq/library/releases/latest/download/install.sh.sha256
sha256sum -c install.sh.sha256
gh attestation verify install.sh --repo slidrhq/library   # who built it (GitHub's CLI, signed in)
sudo bash install.sh
```

The SHA-256 finds a download that went wrong; the attestation says that the repository's release built the script. It asks, and takes each answer as an option too (`--help`; with `--yes` it asks nothing):

- **the media folder** (`--media`): a folder of this machine's own disks, empty or holding a library already. A network file system (NFS, SMB, SSHFS…) is refused, and so is a folder that holds other things;
- **the owner** (`--owner`), who signs in first, by a one-time link the script prints;
- **how it is reached** (`--reach`): `local`, from this machine only, over HTTP (the default); `https`, with a certificate and its key of this machine (`--url`, `--tls-cert`, `--tls-key`); or `proxy`, behind the organization's own HTTPS proxy (`--url`, `--proxy <its address>`, or `local` for a proxy of this machine);
- **the port** (`--port`), 7543 unless it is taken;
- **the data folder** (`--data`), `/var/lib/slidr-library` by default;
- **whether to fill the media** from the central library (`--seed`, `--seed=<address>`, `--no-seed`).

It checks them, shows a summary, and writes nothing until it is accepted. Then: the account `slidr-library` of this machine, made for the library, which the container runs as; the folders, its own; `/etc/slidr-library/compose.yaml` and `library.env` (the answers, nothing secret); the master key, made in `/etc/slidr-library/keys/`, apart from the data folder; the library, installed and seeded in a container of its own; the service, started; and `/usr/local/bin/slidr-library`. A port Docker publishes passes by `ufw`'s and `firewalld`'s rules: the script binds it to `127.0.0.1` unless the library is to be reached from elsewhere.

Installed apps read the media at `<the library's address>/media/` (docs/media-library.md of the app, "A library of your own").

### Running it

```sh
sudo slidr-library status        # whether it runs, where it is, and a test of its media
sudo slidr-library login         # the owner's one-time link (ten minutes, once)
sudo slidr-library logs -f
sudo slidr-library stop | start | restart
sudo slidr-library update        # the newest release; or update <version>
sudo slidr-library change        # how it is reached, or its port
sudo slidr-library sign-in google --client-id <id>   # the provider everyone else signs in through
sudo slidr-library owner <email> # hands the library to another member
sudo slidr-library vault rotate  # a new master key
sudo slidr-library uninstall     # its data, keys and media stay; --purge takes them too
```

- **Updating** runs the newer release's script, checked against its SHA-256, which pins its image by digest. The data, keys and media stay as they are.
- **Backing up**: the data folder, `/etc/slidr-library/keys` (kept apart from the data folder's backup), and the media folder. To restore them, put them back and run the script with the same folders: it finds the library there and keeps it.
- **The container** runs as the account `slidr-library` of the machine, on a read-only root, with no capabilities. Its health is `/api/me` through Nginx; it starts again when it ends.

### What is inside

- **Nginx** (`docker/nginx.conf`) listens on 8080 in the container, over TLS when `/library/tls` holds a certificate. It serves `/media/` from the folder as the library's own server answers it (`media.conf`, its types written from `live.ts` by `pnpm nginx-types`), with `Content-Security-Policy: sandbox`, and the page's built files, and passes the rest to Node on `127.0.0.1:5176`. Its log keeps no query string: the owner's link carries its code in one.
- **The library's server** is bundled into one file (`vite.node.config.ts`, `dist/node/library.mjs`), and the CLI is `slidr-library` in the container (`server/host/node/cli.ts`). `docker/entry.sh` starts both, and the container ends when either ends.
- **The data folder** (`/library/data`) holds `host.json` (where the master key is, and the media folder) and the library's store, `state/`: its settings, its people, its sealed keys (`vault/`) and its uploads.
- **The keys** the library keeps (the key its cookies are signed with, and the secret of its sign-in provider) are sealed with AES-256-GCM under the master key (`server/core/vault.ts`), `/library/keys/master.key`. `vault rotate` writes the new key beside the old one until every key is sealed again.
- **The media** (`/library/media`) is the host's: **Settings** shows it, the room left on its disk, and a **Test** that writes and removes a probe, and never changes it (docs/SPEC.md D13).
- **Its owner** signs in by a one-time link, opened from any address within ten minutes, once (docs/SPEC.md D17).

`.github/workflows/image.yml` builds the image on every push and tries it on x86-64 and ARM64: `docker/test/image.test.ts` (Nginx's `/media/` against the library's own server, an upload by a token approved into the folder, the container's hardening, TLS) and `install/test/install.test.ts` (the script and the command, as root runs them). `.github/workflows/release.yml` makes a release from a tag `v<version>` ([Releasing](#releasing)).

From the source, for working on the code (any system):

```powershell
pnpm install; pnpm build
$env:LIBRARY_MASTER_KEY = '<43 characters: init says how to make one>'
pnpm library init --data D:\tmp\library --owner you@example.org --media D:\tmp\media --master-key-env --seed
pnpm library start --data D:\tmp\library                        # http://127.0.0.1:5176
pnpm library login --data D:\tmp\library                        # the owner's one-time link
```

The page draws the library with the app's own code: the packages it uses (`@slidr/model`, `@slidr/renderer`, `@slidr/templates`, `@slidr/media-library`) and the app's readers of the library in `desktop/src` (imported as `@desktop/…`) are copied into `vendor/` from the app's repository, so this repository stands on its own. [vendor/README.md](vendor/README.md) says how to take a newer version of them. Paths in this README such as `desktop/…` and `packages/…` are of the app's repository.

## What it shows

- **Overview.** Each part of the library, with its number of files and their size, and the date the library was published.
- **Parts.** Ready-made designs, templates, card sets, frames, shapes and lines, graphics, emoji, icons and fonts. Each is read and drawn by the app's own code in `desktop/src` (`src/app.ts` names the modules, copied in `vendor/`): the same catalogs, names, renderer and search in Hebrew and English, which reads the library's search tags (`tags/`, ADR-108 of the app) beside the names, and an item up close shows its tags. A part is loaded when it is opened.
- **Languages.** The language picker at the top shows the library in any content language of the app (`CONTENT_LANGUAGES`), and only what is written in that language: the designs and template samples written in it, and no English in place of the others. Frames and card sets are written in Hebrew and English only, so another language shows none of them, and the picker of a design, a template, a frame or a card set offers only the languages it is written in. Names come from the app's translations (`desktop/src/i18n/locales`), read when a language is chosen. Fonts are only the families of the language (`familyOfLanguage`: made for its letters, or for Latin ones and having its letters, so a Hebrew family is none of English's), and show a sentence in it.
- **An item up close.** A click opens it full size, in the language chosen (the picker of the item switches it), beside what it is made of:
  - a design shows its thumbnail as the gallery shows it, its pictures and its catalog, and links to its request in the studio when the studio made it;
  - a template shows its whole sample deck, its colours, fonts and layouts;
  - a card set shows every kind of card, and the set at every number of cards;
  - a frame is drawn around a photograph, with its pictures made ahead and whether they are still current;
  - an icon, a graphic or an emoji is shown at several sizes, with its markup and its licence: a graphic's or an emoji's is that of the art set it is drawn from, whose files the part counts;
  - a font shows each of its weights, its files and its licence.

  The arrow keys step through the part, and the browser's Back button goes back out.

- **All files.** Every file of the manifest, folder by folder, with its size and SHA-256. Pictures, JSON, fonts and the reference decks open in place.

The library is read once each time the page is loaded; "Refresh" reads it again.

## The studio

When Slidr Studio runs on this machine (`VITE_SLIDR_STUDIO_URL`, `http://127.0.0.1:8765/` by default), the page reads from it which designs it made, and a design the studio made links to its request there. It also says when the studio publishes to another library than the one shown. Without the studio, the page shows the same library, without those links.

## Signing in

The button at the end of the top bar signs in through the library's provider: Google, Microsoft, or any OpenID Connect issuer (`server/core/oidc.ts`). In a local library, the owner also signs in there by a one-time link (`slidr-library login`), which needs no provider at all. Once signed in, the button shows the account and its role.

- **How.** OpenID Connect's authorization code flow, with PKCE, a `state` and a `nonce` (`server/core/auth.ts`). `/auth/login` sends the person to the provider, which sends them back to `/auth/callback`, and the server exchanges the code for the ID token with the client's secret. It checks the token's issuer, audience, expiry and nonce, and that the provider vouches for the address, in a domain the library takes when it names some. Then it sends the person back to the page and the item they signed in from. A sign-in that fails comes back with `?signin=failed`, which the page shows and takes off the address. The provider is the library's settings (`signIn`, with its client's secret in the vault; `slidr-library sign-in` in a local library), or, on Cloudflare until it has them, the Worker's Google client.
- **The provider** is the owner's to name: whoever names it says who each person is, the owner too. Its discovery document is read over HTTPS, and must name the very issuer the library names. Microsoft is named by one tenant, its id or its domain: through `organizations` or `common`, any tenant's admin could give an account any address. A provider's client secret, once kept, goes only to that very provider and client: naming another brings its own.
- **The owner's link** (`/auth/local?code=`) holds for ten minutes, and is used once. It is opened from any address (docs/SPEC.md D17): in a container every request comes through Nginx, and the owner of a server opens it from their own computer; only someone who may run Docker on the machine makes one. Behind a proxy, the server takes who the proxy forwards (`X-Forwarded-For`) only from a proxy of that same machine.
- **The session** is a cookie signed with the library's session key (HMAC-SHA-256): the vault's `session`, or `SESSION_SECRET` on a Worker without a vault (`pnpm dev`). It is `HttpOnly`, `SameSite=Lax`, `Secure` with the `__Host-` prefix over HTTPS, for 14 days. It says who the person is, never what they may do.
- **Who may do what** (docs/SPEC.md §6.1; `server/core/people.ts`, `server/core/uploads/access.ts`). Anyone who signs in may upload, and sees and changes their own uploads. A **reviewer** sees every upload, accepts and rejects them, and publishes what waits. An **admin** also names the members by email (**Members**, in the page's side menu; `/api/members`), blocks a person, and publishes an author's files. The **owner**, who installed the library, is an admin no one removes, and hands the library over to another member. Roles are read on every request, so a role given or taken away counts at once, and each change goes into the audit (`audit/` of the library's store). On Cloudflare, a library that named its editors in the Worker's secrets takes them once: `LIBRARY_OWNER`, or else the first of `LIBRARY_EDITORS`, as its owner, and the other editors as reviewers.
- **The routes** are the server's, ahead of the page's files (`assets.run_worker_first` in `wrangler.jsonc`): `GET /auth/login?return=<path>`, `GET /auth/callback`, `GET /auth/local?code=`, `POST /auth/logout`, and `GET /api/me` (how one signs in here, who is signed in, their role, and what they may do). A route that changes something, sent with a session, must come from the library's own page (its `Origin`).

### Setting it up

1. In the [Google Cloud console](https://console.cloud.google.com/auth/clients), make an OAuth client of the "Web application" type. Its authorized redirect URIs are `https://library.slidr.workers.dev/auth/callback`, and `http://127.0.0.1:5176/auth/callback` for `pnpm dev`. The consent screen asks for no more than `openid`, `email` and `profile`, which Google does not review. While the app is in "Testing", only its test users can sign in.
2. Give the Worker its secrets, once (they stay through every deploy):

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put LIBRARY_OWNER       # the owner, read once, while the library names no one
   ```

   The master key of the Worker's vault (docs/SPEC.md §4.4) is a secret of this repository, `LIBRARY_MASTER_KEY`, which each deploy gives the Worker (`deploy.yml`): `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`, then **Settings** → **Secrets and variables** → **Actions** of the repository. The vault keeps the key the sessions are signed with, and the secret of the sign-in provider the owner names in **Settings**. Keep a copy of the master key elsewhere: without it, what the vault holds cannot be read, everyone signs in again, and the provider is named again.

   Before the Worker had its vault (2026-10-27), it signed its sessions with `SESSION_SECRET` and named its people in `LIBRARY_EDITORS`: the vault took the session key over, the people were imported once, and the deploy took both secrets away.

3. On this machine, copy `.dev.vars.example` to `.dev.vars` and fill it in. Git ignores it.

In a local library, the provider is named by its CLI, with the redirect URI it prints to register with the client (the client's secret is asked for, never given as an option):

```powershell
slidr-library sign-in google --client-id <id> [--allowed-domains example.org]
slidr-library sign-in microsoft --tenant <id> --client-id <id> --allowed-domains example.org
slidr-library sign-in oidc --issuer https://id.example.org/realms/staff --client-id <id> --name Staff
```

Until the Worker has its client, and a vault (or, for `pnpm dev` without one, a `SESSION_SECRET` of at least 32 characters), `/api/me` says signing in is not offered, and the page shows no button.

## Uploading

Content comes into the library through a REST API of the page's Worker, under `/api/` (`server/core/uploads`). An upload is kept apart from the library, in the R2 bucket `slidr-library-uploads`. It is checked against the published library as the app's own tests check what is in it, and waits there to be accepted. Nothing of it reaches the library until a publication takes it.

`GET /api/content` says what each part of the library takes and in which languages, and `GET /api/openapi.json` describes the whole API (OpenAPI 3.1). A slide and a template's sample are described by the model's own JSON Schema, at `/api/schemas/slide.json` and `/api/schemas/sample.json`.

| Part                                              | What an upload does                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Languages                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Designs                                           | `add`: a new ready-made slide and its picture, which join the designs Slidr Studio makes (`elements/designs/managed.json`, `images/designs/m-<id>.webp`), with its names and search tags. `translate`: one of those designs in another language. `draw`: the pictures of a published design's slides as the galleries show them, drawn again (Slidr Studio draws those the library lacks), the app's own designs too. `tag`: the search tags of published designs (below). | Uploaded in Hebrew and English, and accepted once written in every language of the app, as the app's tests hold every design to be. A translation is in any language but Hebrew and English. Tags are in Hebrew and English. |
| Templates                                         | `translate`: a built-in template's sample deck in another language (`templates/catalog.json`, `samples[<template>].<language>`).                                                                                                                                                                                                                                                                                                                                           | Any but Hebrew and English, which the template's source writes.                                                                                                                                                              |
| Card sets, frames, shapes, graphics, emoji, icons | `tag`: the search tags of published items (below). No new items: the app's scripts write their catalogs whole, from the packages they read, or the app's code names what it offers, so a new item would be written over, or never shown. `GET /api/content` says why for each.                                                                                                                                                                                             | Hebrew and English.                                                                                                                                                                                                          |
| Fonts                                             | None, for the same reasons. The app does not search them by tags.                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                              |

An upload holds its content by language, under the codes of `CONTENT_LANGUAGES` (`he`, `en`, `ar`, `fr`, …), and keeps them in the app's order, Hebrew and English first. Each language is checked on its own:

- a design's slide in it is a `Slide` of the model. It shows its own picture (`__subject__`, and `__backdrop__` where a photograph lies under it) and no other file. It says something real: three texts at least, more than 25 characters, no placeholder words. Every run of its text is set in a family of the library that has the language's letters; where its family lacks them, the answer names the family's counterpart (`fonts/catalog.json`, ADR-105 of the app);
- a design and its group are named in Hebrew and English only, as the catalog names them, and a new design comes with its search tags in both (`tags`): the words people type to find it in the app's Ready slides, beside its name (ADR-108 of the app);
- every list of tags, a design's or an item's, holds 3 to 20 tags of one to four words each, in the language's own letters (Hebrew without niqqud, English in lower case) or of numbers and signs alone, as `16:9` or `24/7`, which are typed alike in every language; none twice, and none about how the item is drawn (`icon`, `illustration`, `outline`…; `server/core/uploads/tags.ts`);
- a template's sample is seated on the template's layouts by the template's own engine (`sampleSlides`), as `export-templates.mjs` checks the languages it keeps, and names only pictures the templates have (`templates/pictures.json`).

```text
GET    /api/content                          the parts of the library, its languages, what each takes
GET    /api/openapi.json                     the API
GET    /api/uploads                          the uploads, newest first: ?type ?action ?status ?target ?language ?limit ?after
POST   /api/uploads                          an upload: JSON, or a form with the upload as JSON in `upload` and each file by its name
GET    /api/uploads/<id>                     an upload, all it holds, and the languages it still lacks (`missing`)
DELETE /api/uploads/<id>                     withdraws one that waits, or was rejected
GET    /api/uploads/<id>/files/<name>        one of its files
PUT    /api/uploads/<id>/languages/<lang>    writes it in a language, or again in one, while it waits
DELETE /api/uploads/<id>/languages/<lang>    takes a language away, but for Hebrew and English
POST   /api/uploads/<id>/status              { "status": "accepted" | "rejected" | "pending" | "published", "note"? }
```

A design, in Hebrew and English, with its picture (`design.json` below); then its French, and each other language, one at a time (`fr.json`: `{ "slide": { … } }`); then accepted (`accept.json`: `{ "status": "accepted" }`):

```powershell
curl.exe -F "upload=<design.json;type=application/json" -F "picture=@m-harbour-launch.webp" http://127.0.0.1:5176/api/uploads
curl.exe -X PUT -H "Content-Type: application/json" --data "@fr.json" http://127.0.0.1:5176/api/uploads/<id>/languages/fr
curl.exe -H "Content-Type: application/json" --data "@accept.json" http://127.0.0.1:5176/api/uploads/<id>/status
```

```json
{
  "type": "designs",
  "action": "add",
  "id": "m-harbour-launch",
  "group": "events",
  "subject": [1500, 540],
  "languages": {
    "he": {
      "name": "ערב השקה בנמל",
      "groupName": "אירועים",
      "tags": ["ערב השקה", "השקה", "אירוע", "הזמנה", "נמל"],
      "slide": { "id": "s_1", "elements": [], "timeline": [] }
    },
    "en": {
      "name": "Launch night at the harbour",
      "groupName": "Events",
      "tags": ["launch night", "launch", "event", "invitation", "harbour"],
      "slide": { "id": "s_1", "elements": [], "timeline": [] }
    }
  }
}
```

**Search tags.** Every part the app searches (designs, card sets, frames, shapes, graphics, emoji, icons) takes `tag`: the tags of some of its published items, by the key its catalog gives each (`fluent-emoji:balloon`, `birthday-cake`, `lucide:cake`, `shape:rightArrow`, `magnet-birthday`, `steps`, `birthday`; `GET /api/content` names the keys of each part). The upload is named by its part, one waits at a time, and each item is tagged in both languages. Publishing merges it into `tags/<part>.json`: an item named in it takes these tags, and the others keep theirs. The app's `scripts/tag-elements.mjs` writes them with Claude and sends them this way (`--upload`).

```json
{
  "type": "graphics",
  "action": "tag",
  "id": "graphics",
  "languages": {
    "he": { "tags": { "fluent-emoji:balloon": ["בלון", "יום הולדת", "מסיבה"] } },
    "en": { "tags": { "fluent-emoji:balloon": ["balloon", "birthday", "party"] } }
  }
}
```

The page does the same by hand, under **Uploads** in its side menu (`src/Uploads.tsx`). It lists the uploads by their status. An upload opens up close, drawn by the app's renderer in each of its languages, with the subject's point marked on its picture, beside its languages (each added, replaced or taken away from a JSON file), its status and its history. **New upload** takes the picture and a file for each language, named by it (`he.json`, `en.json`…), or a whole upload as the API takes it, and draws the slide, or the template's sample, before anything is sent. A click on the slide places the subject's point. What the server finds wrong is shown by language.

An upload waits (`pending`) while it is written. It is then `accepted` or `rejected` (with a note). Once the library is in its bucket, approving an upload writes it into the library at once, and it is `published` ([Publishing the uploads](#publishing-the-uploads)); one that cannot be written now stays `accepted`, waiting, and says why. Before then, one marked published that the library does not have after all goes back to `accepted`, by whoever may publish. A program that publishes (a `publish` token, an admin's: the studio) skips the wait: its upload, written in every language it needs, is accepted as it comes and published at once, and the answer to `POST /api/uploads` says what came of it (`publishing`), as an approval's does. An upload is checked once more, against the library as it is then, when it is accepted, and it records who did each of these in its `history`. What does not hold is answered `422`, with every issue at its place: `{ "error": "invalid", "message", "issues": [{ "path": "languages.ja.slide", "message", "language": "ja" }] }`.

**Who may upload, and how.** Anyone who signs in ([Signing in](#signing-in)), from the library's page, or a program by a token of a person's: `Authorization: Bearer slk_…`, and nothing else, no cookie and no `Origin`. A person makes their tokens in their **Profile** (from the account button; `/api/me/tokens`): each named, for 30, 90 (the default) or 365 days or until revoked, shown once and kept only as its hash (`server/core/tokens.ts`). A token acts as its person, within its scope: `upload` makes, reads, changes and withdraws that person's own uploads; `publish`, which only an admin makes, also publishes what waits, an author's files, and the library brought in. Approving is a person's, on the page. A `publish` token whose person is no longer an admin does nothing at all, and is taken away when their role is. A token that is unknown, revoked, expired, or of someone blocked answers 401, the same each time; an admin sees and revokes anyone's tokens, and blocking a person revokes them all. Anyone without a role keeps at most 20 uploads waiting, 200 MiB of their files, 10 tokens, and 60 changes a minute (`server/core/limits.ts`; the library's settings may name others). A program is a person's, and sends their token: the studio and `scripts/import-library.mjs` a `publish` one, an admin's, since they publish; the app's `tag-elements.mjs --upload` an `upload` one. The keys the Worker named before (`LIBRARY_KEYS`) open nothing any more. `server/core/uploads/access.ts` decides, by what each route is about to do. What describes the API (`/api/content`, `/api/openapi.json`, `/api/schemas/`) is open to anyone. An upload records who did each thing, by address and the token's name; what a program's key did before keeps the program's name (`key:<name>`).

Search-tag uploads may also include any of the other supported content languages alongside Hebrew and English. All supplied languages must tag the same item keys. The app's `desktop/scripts/translate-tags.mjs` translates existing tags into the other fourteen languages before `tag-elements.mjs --upload` sends them. Native accents, vowel marks and capitalization are preserved; English remains lowercase and Hebrew remains without niqqud.

## Publishing the uploads

The published media library lives in the Worker's own R2 bucket, `slidr-media` (`MEDIA`, `server/core/media/live.ts`): every file under its path, and `manifest.json`, which names each with its size and SHA-256 as the app reads it. The bucket is public, and holds the library and nothing else. media.slidr.studio, where every installed app reads the library, is the bucket itself, with Cloudflare's cache before it, and no Worker runs when it is read ([Serving the library](#serving-the-library)). The Worker serves the same bucket at `/media/` (`server/core/media/serve.ts`), with the headers Cloudflare Pages gave it, as a dev server does. No author's copy of the library and no `pnpm media:publish` take part: what reaches the library comes through the uploads, and a publication writes the accepted ones into the bucket.

```text
GET  /api/library            where the library is, when it was published, how many uploads wait
POST /api/publish            every accepted upload, oldest first; or { "uploads": ["u-…"] } (Try again)
GET  /api/publications       what each publication did, newest first (?before=, ?limit=)
GET  /api/publications/<at>  one of them
POST /api/library/import     once: the site's library into the bucket, a batch per call
PUT  /api/library/staged/…   a file of an author's publication (pnpm media:publish of the app)
POST /api/library/files      an author's publication: the files changed since the copy was pulled
GET  /media/<path>           the library in the bucket, as a dev server serves it
```

Approving an upload publishes it, in the same request, and the answer says how that went (`publishing`). The library's own jobs (`server/core/media/sweep.ts`) publish every approved upload that waits and is due, and once a day take away rejected uploads untouched for 30 days and all but the last 100 publications' history. On a machine they run once a minute, by the process's timer. On Cloudflare they run from a Cron Trigger, once a minute (`wrangler.jsonc`; turned on 2026-10-27). A publication (`server/core/media/publish.ts`):

- checks each upload once more against the library as it is; one that no longer holds goes back to `pending`, with a note that says why, for its uploader to put right; one that cannot be written now stays `accepted`, waiting (`publication`: why, the tries, the next), and is tried again after 1, 5 and 30 minutes, and then by hand (**Try again**, `POST /api/publish` with the upload); one that waits while another publication holds the library is tried at the next round (`server/core/media/settle.ts`);
- writes each into the files it changes (`server/core/media/merge.ts`): the tags of a part merged into `tags/<part>.json`, where an item named takes the tags given in every language given and the others keep theirs; a new design into `elements/designs/managed.json` (its names, group, slides, subject, size and tags) with its picture in `images/designs/`, and the picture of each of its slides that the galleries show when it brings them (`thumb-<language>`, 320 × 180, in `images/designs/thumbs/320/<language>/`); a design's translation into its slides, with their pictures too; a drawing's pictures, each named by the word of the slide it was drawn of while the slide still has it; a template's sample into `templates/catalog.json`, which changes in no other byte;
- writes again what the app reads of the designs, made of their catalogs (`server/core/media/designFiles.ts`): each catalog in each language (`elements/designs/<language>/index.json`, `managed.json`), the word of each design in each language, of its slide and its pictures (`elements/designs/revs.json`, as the app's `designWord.ts` makes it), and the word each picture of a slide that came with an upload was drawn from (`images/designs/thumbs/index.json`). An app takes none of them when they are of another library, and draws every design live then: so each publication writes them as the library now is, and one that takes no upload (**Try again**) writes them where they are not. A design changed since the picture of its slide was drawn is drawn live, alone. A catalog the last words were made of is not read again: the authored one is some 43 MB;
- keeps what it replaces beside the uploads, under `media/history/<published>/` of `slidr-library-uploads` (the manifest before it, and each file it wrote over), writes the manifest last, empties the cache of every file it wrote and of the manifest, and marks each upload `published`. The app takes the new library the next time it reads the manifest. The answer says what became of the cache (`cache`: `files`, `host`, or `none` and why), and is kept as `media/publications/<published>.json`;
- when it fails before the manifest is written, puts the media back as it was: each file it replaced, from the history, and each it added, taken away (`server/core/media/writing.ts`).

**An author's files.** What the app's generators write (the catalogs of icons, frames and authored designs, the templates and their sources' samples, the fonts) is still made in an author's copy of the library, and published from it by `pnpm media:publish` of the app, through this API too: it sends each file the author changed since the copy was pulled (`PUT /api/library/staged/<sha256>`), and then the publication of them (`POST /api/library/files`), each path with the hash it was changed from (`server/core/media/files.ts`). A file the library changed meanwhile, as an upload that was published, is a conflict, and nothing is written: the author pulls (`pnpm media:pull`) and publishes again. Every file the author did not change stays as the library has it, so a publication of an author's files never takes away a published upload.

One publication runs at a time: it holds `media/lock.json` beside the uploads, taken and let go only over the version read just before, kept once a minute while it writes, and taken over when left unkept for ten minutes (`server/core/media/lease.ts`). Up to 50 uploads go in one, and the answer says how many are left. Once the library is in its bucket, an upload is no longer marked published by hand (`409 publish-instead`): it is published. The page's **Uploads** publishes every accepted upload that waits at once, and an upload up close by itself; Slidr Studio's Publish panel publishes them too, with its key.

**Setting it up**, once:

1. Make the bucket, and publish the Worker with it (`wrangler.jsonc` binds it):
   ```powershell
   npx wrangler r2 bucket create slidr-media
   pnpm build; npx wrangler deploy
   ```
2. Bring the published library into the bucket, from media.slidr.studio as Pages serves it now. A call copies a batch, checked file by file; the script calls until the bucket has every file and the manifest:
   ```powershell
   $env:LIBRARY_TOKEN = 'slk_…'   # an admin's token, of the publish scope (the profile)
   node scripts/import-library.mjs
   ```
   `https://library.slidr.workers.dev/media/manifest.json` then answers with the library.
3. Put media.slidr.studio before the bucket itself, and take the Pages project away ([Serving the library](#serving-the-library), "Setting it up"). Every installed app reads the bucket from then on.
4. Publish the uploads accepted until then: **Uploads** → **Publish N accepted**, or `POST /api/publish`. From then on, approving publishes.

## Serving the library

media.slidr.studio is a custom domain of the bucket `slidr-media`. Cloudflare answers from its cache, and reads a file from the bucket only when the cache does not hold it. No Worker runs, so reading the library costs nothing by the request: Cloudflare's cache and R2's egress are free, and R2 counts only the reads that reach the bucket (10 million a month are free), which are about one a file a day and after a publication, however many apps read it.

- **What a file is answered with.** The type and the caching it was written with (`server/core/media/live.ts`): the manifest `no-cache`, every other file `public, max-age=0, must-revalidate`, as Pages served them. The zone's rule below adds what the Worker added: `Access-Control-Allow-Origin: *` and `X-Slidr-Library: live`, by which the app's `pnpm media:publish` knows to publish through the API. A file's ETag is R2's own, not its SHA-256; the app checks each file against the manifest, and sends no `If-None-Match`.
- **How long the cache keeps it.** A file a day, the manifest two hours (the least the Free plan allows). A publication empties the cache of every file it wrote or took away, and of the manifest, as soon as the manifest is written (`server/core/media/cache.ts`): by their addresses, 100 a call, or the whole host when they are more than 300. Every other file stays in the cache.
- **When the cache cannot be emptied** (the Worker lacks `MEDIA_ZONE_ID` and `MEDIA_PURGE_TOKEN`, or Cloudflare refuses), the publication is written all the same, says so in its answer, and the Worker logs why. The cache then holds the old files for a day at most, and the manifest for two hours. Meanwhile an app may read the new manifest and an old file: it shows the old file and does not keep it. To empty it by hand: the zone's **Caching** → **Configuration** → **Custom Purge** → **Hostname** `media.slidr.studio`.

**Setting it up** (done on 2026-10-25), once, after the library is in the bucket ([Publishing the uploads](#publishing-the-uploads), step 2: it is read from media.slidr.studio as Pages serves it). The address does not answer for a minute or two between steps 2 and 3; an installed app works from what it keeps meanwhile.

1. The bucket's CORS policy, for a browser that asks before it reads (the zone's rule in step 4 gives every answer its CORS headers, cached or not):
   ```powershell
   npx wrangler r2 bucket cors set slidr-media --file media-cors.json
   ```
2. Take media.slidr.studio from the Pages project: **Workers & Pages** → `slidr-media` → **Custom domains** → remove it; then remove its DNS record from the zone slidr.studio (`media`, a CNAME to slidr-media.pages.dev).
3. Give it to the bucket: **R2** → `slidr-media` → **Settings** → **Custom Domains** → **Add** → `media.slidr.studio`. R2 makes its DNS record and its certificate.
4. In the zone slidr.studio:
   - **Caching** → **Tiered Cache** → **Smart Tiered Caching** on: one data center reads the bucket for all the others.
   - **Caching** → **Cache Rules**, in this order:
     - _Media library_: hostname equals `media.slidr.studio` → **Eligible for cache**; **Edge TTL**: ignore cache-control header and use this TTL, 1 day; **Browser TTL**: respect origin.
     - _Media manifest_: hostname equals `media.slidr.studio` and URI path equals `/manifest.json` → **Eligible for cache**; **Edge TTL**: ignore cache-control header and use this TTL, 2 hours; **Browser TTL**: respect origin.
   - **Rules** → **Transform Rules** → **Modify Response Header**, _Media library headers_: hostname equals `media.slidr.studio` → set static `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: ETag`, `X-Content-Type-Options: nosniff`, `X-Slidr-Library: live`.
   - **Rules** → **Configuration Rules**, _Media library: no rewriting of HTML_: hostname equals `media.slidr.studio` → Email Obfuscation, Automatic HTTPS Rewrites, Server Side Excludes and Rocket Loader off, Web Analytics (RUM) and Zaraz disabled. The zone rewrites the e-mail addresses of HTML otherwise (`templates/reference-decks/*.html`), and the app checks every file against its SHA-256.
5. A token that may empty the cache (the account's token `slidr-library-purge`): **Manage Account** → **Account API Tokens** → **Create Token** → custom, permission Zone → **Cache Purge** → Purge, for the zone slidr.studio. Then the Worker's secrets:
   ```powershell
   npx wrangler secret put MEDIA_ZONE_ID       # the zone's id, on its Overview page
   npx wrangler secret put MEDIA_PURGE_TOKEN
   ```
6. Check it: `curl.exe -sI https://media.slidr.studio/manifest.json` answers `X-Slidr-Library: live` and `Cache-Control: no-cache`, and asked again, `cf-cache-status: HIT`; `/fonts/catalog.json` answers `Access-Control-Allow-Origin: *`.
7. Delete the Pages project `slidr-media` (**Workers & Pages** → `slidr-media` → **Settings** → **Delete project**). slidr-media.pages.dev stops answering: no release of the app reads it.

## Publishing

The page runs on Cloudflare as the Worker `library` (https://library.slidr.workers.dev), which serves the page from `dist/client` and runs `server/host/cloudflare/index.ts` (the library's server, `server/core`): signing in, and the uploads (`wrangler.jsonc`; `pnpm build` writes both, and the Worker's own configuration to `dist/library`). `.github/workflows/deploy.yml` checks, tests, builds and publishes it on every push to `main`, and you can run it by hand from the Actions tab. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To publish from your own machine: `pnpm build`, then `npx wrangler deploy`.

The uploads are kept in the R2 bucket `slidr-library-uploads`, which is made once, before the first publication: `npx wrangler r2 bucket create slidr-library-uploads`, and the published library in `slidr-media` ([Publishing the uploads](#publishing-the-uploads)). They are checked against the library in its bucket, and before it is there against the site, `https://media.slidr.studio/`, unless the Worker's variable `MEDIA_LIBRARY_URL` names another. Checking an upload (a design in every language, a sample seated on its template) takes more CPU time than the Free plan's 10 ms a request, so the Worker runs on Workers Paid. `pnpm dev` runs the Worker beside the page, with buckets of its own on this machine, in `.wrangler/`: `node scripts/import-library.mjs --url http://127.0.0.1:5176` brings the library into them.

## Releasing

A release of the local library is made from a tag `v<version>` that `package.json` names (`.github/workflows/release.yml`): it checks and tests, builds the image for x86-64 and ARM64 and pushes it to `ghcr.io/slidrhq/library` (`<version>`, `<major>.<minor>`, `latest`) with its SBOM and an attested provenance (`gh attestation verify oci://ghcr.io/slidrhq/library:<version> --repo slidrhq/library`), tries that very image as a machine pulls it, and makes a GitHub release with `install.sh`, which names the release's version and its image by digest, and `install.sh.sha256`. A tag deploys nothing to Cloudflare.

Once, after the first release pushed the image: the package `library` on ghcr.io is made public (**Package settings** → **Change visibility**), since a package starts private even from a public repository; then the release's failed jobs are run again.

## Working on the page

`pnpm check` runs `typecheck` (the page, and the server with `server/tsconfig.json`), `eslint` and `prettier`. `pnpm test` runs the server's tests (`server/**/*.test.ts`) in Node's test runner, with Google's token endpoint and the published library stood in for; `server/node.mjs` lets Node import the app's code in `vendor/` as a bundler does. The words of the page are in `src/i18n`: each area in Hebrew and English in `areas/<area>.ts`, and every other language in `locales/<lang>.ts`.
