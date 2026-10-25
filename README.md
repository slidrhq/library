# Slidr Library

A web page that shows the media library as it is published (docs/media-library.md of the app), as every installed app reads it. The page only reads the library: changing it goes through publishing, from [Slidr Studio](https://github.com/slidrhq/studio) or the app's `pnpm media:publish`. It reads the site directly (`@slidr/media-library`). Its own Worker signs people in with a Google account ([Signing in](#signing-in)), and takes the content the library's editors upload, keeping it until it is published ([Uploading](#uploading)).

## Setup

```powershell
pnpm install
pnpm dev               # http://127.0.0.1:5176, with the Worker
pnpm test              # the Worker's tests
pnpm build; pnpm preview
```

`pnpm dev` and `pnpm preview` run the Worker inside Vite (`@cloudflare/vite-plugin`, in Cloudflare's own runtime), with the secrets of `.dev.vars`. Without that file the page works the same, and offers no signing in.

The page draws the library with the app's own code: the packages it uses (`@slidr/model`, `@slidr/renderer`, `@slidr/templates`, `@slidr/media-library`) and the app's readers of the library in `desktop/src` (imported as `@desktop/…`) are copied into `vendor/` from the app's repository, so this repository stands on its own. [vendor/README.md](vendor/README.md) says how to take a newer version of them. Paths in this README such as `desktop/…` and `packages/…` are of the app's repository.

## What it shows

- **Overview.** Each part of the library, with its number of files and their size, and the date the library was published.
- **Parts.** Ready-made designs, templates, card sets, frames, shapes and lines, graphics, emoji, art sets, icons and fonts. Each is read and drawn by the app's own code in `desktop/src` (`src/app.ts` names the modules, copied in `vendor/`): the same catalogs, names, renderer and search in Hebrew and English, which reads the library's search tags (`tags/`, ADR-108 of the app) beside the names, and an item up close shows its tags. A part is loaded when it is opened.
- **Languages.** The language picker at the top shows the library in any content language of the app (`CONTENT_LANGUAGES`), and only what is written in that language: the designs and template samples written in it, and no English in place of the others. Frames and card sets are written in Hebrew and English only, so another language shows none of them, and the picker of a design, a template, a frame or a card set offers only the languages it is written in. Names come from the app's translations (`desktop/src/i18n/locales`), read when a language is chosen. Fonts are only the families of the language (`familyOfLanguage`: made for its letters, or for Latin ones and having its letters, so a Hebrew family is none of English's), and show a sentence in it.
- **An item up close.** A click opens it full size, in the language chosen (the picker of the item switches it), beside what it is made of:
  - a design shows its thumbnail as the gallery shows it, its pictures and its catalog, and links to its request in the studio when the studio made it;
  - a template shows its whole sample deck, its colours, fonts and layouts;
  - a card set shows every kind of card, and the set at every number of cards;
  - a frame is drawn around a photograph, with its pictures made ahead and whether they are still current;
  - an icon, a graphic or a drawing is shown at several sizes, with its markup and its licence;
  - a font shows each of its weights, its files and its licence.

  The arrow keys step through the part, and the browser's Back button goes back out.

- **All files.** Every file of the manifest, folder by folder, with its size and SHA-256. Pictures, JSON, fonts and the reference decks open in place.

The library is read once each time the page is loaded; "Refresh" reads it again.

## The studio

When Slidr Studio runs on this machine (`VITE_SLIDR_STUDIO_URL`, `http://127.0.0.1:8765/` by default), the page reads from it which designs it made, and a design the studio made links to its request there. It also says when the studio publishes to another library than the one shown. Without the studio, the page shows the same library, without those links.

## Signing in

The button at the end of the top bar signs in with a Google account. Once signed in, it shows the account, and whether it may upload content to the library ([Uploading](#uploading)).

- **How.** OpenID Connect's authorization code flow, with PKCE, a `state` and a `nonce` (`worker/auth.ts`). `/auth/login` sends the person to Google, Google sends them back to `/auth/callback`, and the Worker exchanges the code for the ID token with the client's secret. It checks the token's issuer, audience, expiry and nonce, and that the address is verified. Then it sends the person back to the page and the item they signed in from. A sign-in that fails comes back with `?signin=failed`, which the page shows and takes off the address.
- **The session** is a cookie signed with `SESSION_SECRET` (HMAC-SHA-256): `HttpOnly`, `SameSite=Lax`, `Secure` with the `__Host-` prefix over HTTPS, for 14 days. The Worker keeps no store. Changing `SESSION_SECRET` signs everyone out.
- **Who may upload** is `LIBRARY_EDITORS`: Google accounts by address, separated by commas. Anyone with a Google account can sign in, and only these may upload. The list is read on every request, so an address taken off it loses the right at once.
- **The routes** are the Worker's, ahead of the page's files (`assets.run_worker_first` in `wrangler.jsonc`): `GET /auth/login?return=<path>`, `GET /auth/callback`, `POST /auth/logout`, and `GET /api/me` (whether signing in is offered, and who is signed in). Every route of the uploads starts with `requireEditor(request, env)` of `worker/auth.ts`, through `worker/uploads/access.ts`. That answers 401 without a session, and 403 for an account the list does not name or for a request from another site (its `Origin`).

### Setting it up

1. In the [Google Cloud console](https://console.cloud.google.com/auth/clients), make an OAuth client of the "Web application" type. Its authorized redirect URIs are `https://library.slidr.workers.dev/auth/callback`, and `http://127.0.0.1:5176/auth/callback` for `pnpm dev`. The consent screen asks for no more than `openid`, `email` and `profile`, which Google does not review. While the app is in "Testing", only its test users can sign in.
2. Give the Worker its secrets, once (they stay through every deploy):

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
   npx wrangler secret put LIBRARY_EDITORS     # you@example.com, someone@example.com
   npx wrangler secret put LIBRARY_KEYS        # if programs upload: studio=<key>, ci=<key>
   ```

3. On this machine, copy `.dev.vars.example` to `.dev.vars` and fill it in. Git ignores it.

Until the Worker has its client and a `SESSION_SECRET` of at least 32 characters, `/api/me` says signing in is not offered, and the page shows no button.

## Uploading

Content comes into the library through a REST API of the page's Worker, under `/api/` (`worker/uploads`). An upload is kept apart from the library, in the R2 bucket `slidr-library-uploads`. It is checked against the published library as the app's own tests check what is in it, and waits there to be accepted. Nothing of it reaches the library until a publication takes it.

`GET /api/content` says what each part of the library takes and in which languages, and `GET /api/openapi.json` describes the whole API (OpenAPI 3.1). A slide and a template's sample are described by the model's own JSON Schema, at `/api/schemas/slide.json` and `/api/schemas/sample.json`.

| Part                                              | What an upload does                                                                                                                                                                                                                                                                                   | Languages                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Designs                                           | `add`: a new ready-made slide and its picture, which join the designs Slidr Studio makes (`elements/designs/managed.json`, `images/designs/m-<id>.webp`), with its names and search tags. `translate`: one of those designs in another language. `tag`: the search tags of published designs (below). | Uploaded in Hebrew and English, and accepted once written in every language of the app, as the app's tests hold every design to be. A translation is in any language but Hebrew and English. Tags are in Hebrew and English. |
| Templates                                         | `translate`: a built-in template's sample deck in another language (`templates/catalog.json`, `samples[<template>].<language>`).                                                                                                                                                                      | Any but Hebrew and English, which the template's source writes.                                                                                                                                                              |
| Card sets, frames, shapes, graphics, emoji, icons | `tag`: the search tags of published items (below). No new items: the app's scripts write their catalogs whole, from the packages they read, or the app's code names what it offers, so a new item would be written over, or never shown. `GET /api/content` says why for each.                        | Hebrew and English.                                                                                                                                                                                                          |
| Art sets, fonts                                   | None, for the same reasons. The app does not search them by tags.                                                                                                                                                                                                                                     |                                                                                                                                                                                                                              |

An upload holds its content by language, under the codes of `CONTENT_LANGUAGES` (`he`, `en`, `ar`, `fr`, …), and keeps them in the app's order, Hebrew and English first. Each language is checked on its own:

- a design's slide in it is a `Slide` of the model. It shows its own picture (`__subject__`, and `__backdrop__` where a photograph lies under it) and no other file. It says something real: three texts at least, more than 25 characters, no placeholder words. Every run of its text is set in a family of the library that has the language's letters; where its family lacks them, the answer names the family's counterpart (`fonts/catalog.json`, ADR-105 of the app);
- a design and its group are named in Hebrew and English only, as the catalog names them, and a new design comes with its search tags in both (`tags`): the words people type to find it in the app's Ready slides, beside its name (ADR-108 of the app);
- every list of tags, a design's or an item's, holds 3 to 20 tags of one to four words each, in the language's own letters: Hebrew without niqqud, English in lower case, none twice, and none about how the item is drawn (`icon`, `illustration`, `outline`…; `worker/uploads/tags.ts`);
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

An upload waits (`pending`) while it is written. It is then `accepted` or `rejected` (with a note), and an accepted one is `published` when a publication writes it into the library ([Publishing the uploads](#publishing-the-uploads)). One marked published that the library does not have after all goes back to `accepted`, by whoever may publish. An upload is checked once more, against the library as it is then, when it is accepted, and it records who did each of these in its `history`. What does not hold is answered `422`, with every issue at its place: `{ "error": "invalid", "message", "issues": [{ "path": "languages.ja.slide", "message", "language": "ja" }] }`.

**Who may upload.** The uploads are the library's editors' ([Signing in](#signing-in)): a person signed in with a Google account that `LIBRARY_EDITORS` names, on the library's own page, or a program by a key of its own, sent as `Authorization: Bearer <key>`. The programs and their keys are the Worker's secret `LIBRARY_KEYS` (`studio=<key>, ci=<key>`, each key at least 32 characters); a key sends no cookie, and so is not asked which site it comes from. An editor or a program may do all an upload takes: upload, review and say it is published. `worker/uploads/access.ts` decides, by what each route is about to do (`read`, `upload`, `review`, `publish`). What describes the API (`/api/content`, `/api/openapi.json`, `/api/schemas/`) is open to anyone. An upload records who did each thing, by address or by the program's name. The page's **Uploads** shows the uploads to an editor; it asks anyone else to sign in, or says why it is closed to them.

Search-tag uploads may also include any of the other supported content languages alongside Hebrew and English. All supplied languages must tag the same item keys. The app's `desktop/scripts/translate-tags.mjs` translates existing tags into the other fourteen languages before `tag-elements.mjs --upload` sends them. Native accents, vowel marks and capitalization are preserved; English remains lowercase and Hebrew remains without niqqud.

## Publishing the uploads

The published media library lives in the Worker's own R2 bucket, `slidr-media` (`MEDIA`, `worker/media/live.ts`): every file under its path, and `manifest.json`, which names each with its size and SHA-256 as the app reads it. The bucket is public, and holds the library and nothing else. media.slidr.studio, where every installed app reads the library, is the bucket itself, with Cloudflare's cache before it, and no Worker runs when it is read ([Serving the library](#serving-the-library)). The Worker serves the same bucket at `/media/` (`worker/media/serve.ts`), with the headers Cloudflare Pages gave it, as a dev server does. No author's copy of the library and no `pnpm media:publish` take part: what reaches the library comes through the uploads, and a publication writes the accepted ones into the bucket.

```text
GET  /api/library            where the library is, when it was published, how many uploads wait
POST /api/publish            every accepted upload, oldest first; or { "uploads": ["u-…"] }
POST /api/library/import     once: the site's library into the bucket, a batch per call
PUT  /api/library/staged/…   a file of an author's publication (pnpm media:publish of the app)
POST /api/library/files      an author's publication: the files changed since the copy was pulled
GET  /media/<path>           the library in the bucket, as a dev server serves it
```

A publication (`worker/media/publish.ts`), by an editor or a program that may publish:

- checks each upload once more against the library as it is, and leaves accepted one that no longer holds, saying why (`skipped`);
- writes each into the files it changes (`worker/media/merge.ts`): the tags of a part merged into `tags/<part>.json`, where an item named takes the tags given in every language given and the others keep theirs; a new design into `elements/designs/managed.json` (its names, group, slides, subject, size and tags) with its picture in `images/designs/`; a design's translation into its slides; a template's sample into `templates/catalog.json`, which changes in no other byte;
- keeps what it replaces beside the uploads, under `media/history/<published>/` of `slidr-library-uploads` (the manifest before it, and each file it wrote over), writes the manifest last, empties the cache of every file it wrote and of the manifest, and marks each upload `published`. The app takes the new library the next time it reads the manifest. The answer says what became of the cache (`cache`: `files`, `host`, or `none` and why).

**An author's files.** What the app's generators write (the catalogs of icons, frames and authored designs, the templates and their sources' samples, the fonts) is still made in an author's copy of the library, and published from it by `pnpm media:publish` of the app, through this API too: it sends each file the author changed since the copy was pulled (`PUT /api/library/staged/<sha256>`), and then the publication of them (`POST /api/library/files`), each path with the hash it was changed from (`worker/media/files.ts`). A file the library changed meanwhile, as an upload that was published, is a conflict, and nothing is written: the author pulls (`pnpm media:pull`) and publishes again. Every file the author did not change stays as the library has it, so a publication of an author's files never takes away a published upload.

One publication runs at a time. Up to 50 uploads go in one, and the answer says how many are left. Once the library is in its bucket, an upload is no longer marked published by hand (`409 publish-instead`): it is published. The page's **Uploads** publishes every accepted upload at once, and an upload up close by itself; Slidr Studio's Publish panel publishes them too, with its key.

**Setting it up**, once:

1. Make the bucket, and publish the Worker with it (`wrangler.jsonc` binds it):
   ```powershell
   npx wrangler r2 bucket create slidr-media
   pnpm build; npx wrangler deploy
   ```
2. Bring the published library into the bucket, from media.slidr.studio as Pages serves it now. A call copies a batch, checked file by file; the script calls until the bucket has every file and the manifest:
   ```powershell
   $env:LIBRARY_KEY = '<a key of LIBRARY_KEYS>'
   node scripts/import-library.mjs
   ```
   `https://library.slidr.workers.dev/media/manifest.json` then answers with the library.
3. Put media.slidr.studio before the bucket itself, and take the Pages project away ([Serving the library](#serving-the-library), "Setting it up"). Every installed app reads the bucket from then on.
4. Publish the accepted uploads: **Uploads** → **Publish N accepted**, or `POST /api/publish`.

## Serving the library

media.slidr.studio is a custom domain of the bucket `slidr-media`. Cloudflare answers from its cache, and reads a file from the bucket only when the cache does not hold it. No Worker runs, so reading the library costs nothing by the request: Cloudflare's cache and R2's egress are free, and R2 counts only the reads that reach the bucket (10 million a month are free), which are about one a file a day and after a publication, however many apps read it.

- **What a file is answered with.** The type and the caching it was written with (`worker/media/live.ts`): the manifest `no-cache`, every other file `public, max-age=0, must-revalidate`, as Pages served them. The zone's rule below adds what the Worker added: `Access-Control-Allow-Origin: *` and `X-Slidr-Library: live`, by which the app's `pnpm media:publish` knows to publish through the API. A file's ETag is R2's own, not its SHA-256; the app checks each file against the manifest, and sends no `If-None-Match`.
- **How long the cache keeps it.** A file a day, the manifest two hours (the least the Free plan allows). A publication empties the cache of every file it wrote or took away, and of the manifest, as soon as the manifest is written (`worker/media/cache.ts`): by their addresses, 100 a call, or the whole host when they are more than 300. Every other file stays in the cache.
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

The page runs on Cloudflare as the Worker `library` (https://library.slidr.workers.dev), which serves the page from `dist/client` and runs `worker/index.ts`: signing in, and the uploads (`wrangler.jsonc`; `pnpm build` writes both, and the Worker's own configuration to `dist/library`). `.github/workflows/deploy.yml` checks, tests, builds and publishes it on every push to `main`, and you can run it by hand from the Actions tab. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To publish from your own machine: `pnpm build`, then `npx wrangler deploy`.

The uploads are kept in the R2 bucket `slidr-library-uploads`, which is made once, before the first publication: `npx wrangler r2 bucket create slidr-library-uploads`, and the published library in `slidr-media` ([Publishing the uploads](#publishing-the-uploads)). They are checked against the library in its bucket, and before it is there against the site, `https://media.slidr.studio/`, unless the Worker's variable `MEDIA_LIBRARY_URL` names another. Checking an upload (a design in every language, a sample seated on its template) takes more CPU time than the Free plan's 10 ms a request, so the Worker runs on Workers Paid. `pnpm dev` runs the Worker beside the page, with buckets of its own on this machine, in `.wrangler/`: `node scripts/import-library.mjs --url http://127.0.0.1:5176` brings the library into them.

## Working on the page

`pnpm check` runs `typecheck` (the page, and the Worker with `worker/tsconfig.json`), `eslint` and `prettier`. `pnpm test` runs the Worker's tests (`worker/**/*.test.ts`) in Node's test runner, with Google's token endpoint and the published library stood in for; `worker/node.mjs` lets Node import the app's code in `vendor/` as a bundler does. The words of the page are in `src/i18n`: each area in Hebrew and English in `areas/<area>.ts`, and every other language in `locales/<lang>.ts`.
