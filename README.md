# Slidr Library

A web page that shows the media library as it is published (docs/media-library.md of the app), as every installed app reads it. The page only reads: changing the library goes through publishing, from [Slidr Studio](https://github.com/slidrhq/studio) or the app's `pnpm media:publish`. It reads the site directly (`@slidr/media-library`). Content for the library is uploaded to the page's server, which keeps it until it is published ([Uploading](#uploading)).

## Setup

```powershell
pnpm install
pnpm dev               # http://127.0.0.1:5176, with the uploads' API
pnpm test              # the server's tests
pnpm build; pnpm preview
```

The page draws the library with the app's own code: the packages it uses (`@slidr/model`, `@slidr/renderer`, `@slidr/templates`, `@slidr/media-library`) and the app's readers of the library in `apps/desktop/src` (imported as `@desktop/…`) are copied into `vendor/` from the app's repository, so this repository stands on its own. [vendor/README.md](vendor/README.md) says how to take a newer version of them. Paths in this README such as `apps/desktop/…` and `packages/…` are of the app's repository.

## What it shows

- **Overview.** Each part of the library, with its number of files and their size, and the date the library was published.
- **Parts.** Ready-made designs, templates, card sets, frames, shapes and lines, graphics, emoji, art sets, icons and fonts. Each is read and drawn by the app's own code in `apps/desktop/src` (`src/app.ts` names the modules, copied in `vendor/`): the same catalogs, names, renderer and search in Hebrew and English. A part is loaded when it is opened.
- **Languages.** The language picker at the top shows the library in any content language of the app (`CONTENT_LANGUAGES`), and only what is written in that language: the designs and template samples written in it, and no English in place of the others. Frames and card sets are written in Hebrew and English only, so another language shows none of them, and the picker of a design, a template, a frame or a card set offers only the languages it is written in. Names come from the app's translations (`apps/desktop/src/i18n/locales`), read when a language is chosen. Fonts are only the families of the language (`familyOfLanguage`: made for its letters, or for Latin ones and having its letters, so a Hebrew family is none of English's), and show a sentence in it.
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

## Uploading

Content comes into the library through a REST API of the page's Worker, under `/api/` (`worker/uploads`). An upload is kept apart from the library, in the R2 bucket `slidr-library-uploads`. It is checked against the published library as the app's own tests check what is in it, and waits there to be accepted. Nothing of it reaches the library until a publication takes it.

`GET /api/content` says what each part of the library takes and in which languages, and `GET /api/openapi.json` describes the whole API (OpenAPI 3.1). A slide and a template's sample are described by the model's own JSON Schema, at `/api/schemas/slide.json` and `/api/schemas/sample.json`.

| Part                                                               | What an upload does                                                                                                                                                                                                | Languages                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Designs                                                            | `add`: a new ready-made slide and its picture, which join the designs Slidr Studio makes (`elements/designs/managed.json`, `images/designs/m-<id>.webp`). `translate`: one of those designs in another language.   | Uploaded in Hebrew and English, and accepted once written in every language of the app, as the app's tests hold every design to be. A translation is in any language but Hebrew and English. |
| Templates                                                          | `translate`: a built-in template's sample deck in another language (`templates/catalog.json`, `samples[<template>].<language>`).                                                                                   | Any but Hebrew and English, which the template's source writes.                                                                                                                              |
| Card sets, frames, shapes, graphics, emoji, art sets, icons, fonts | None. The app's scripts write their catalogs whole, from the packages they read, or the app's code names what it offers, so an upload would be written over, or never shown. `GET /api/content` says why for each. |                                                                                                                                                                                              |

An upload holds its content by language, under the codes of `CONTENT_LANGUAGES` (`he`, `en`, `ar`, `fr`, …), and keeps them in the app's order, Hebrew and English first. Each language is checked on its own:

- a design's slide in it is a `Slide` of the model. It shows its own picture (`__subject__`, and `__backdrop__` where a photograph lies under it) and no other file. It says something real: three texts at least, more than 25 characters, no placeholder words. Every run of its text is set in a family of the library that has the language's letters; where its family lacks them, the answer names the family's counterpart (`fonts/catalog.json`, ADR-105 of the app);
- a design and its group are named in Hebrew and English only, as the catalog names them;
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
      "slide": { "id": "s_1", "elements": [], "timeline": [] }
    },
    "en": {
      "name": "Launch night at the harbour",
      "groupName": "Events",
      "slide": { "id": "s_1", "elements": [], "timeline": [] }
    }
  }
}
```

The page does the same by hand, under **Uploads** in its side menu (`src/Uploads.tsx`). It lists the uploads by their status. An upload opens up close, drawn by the app's renderer in each of its languages, with the subject's point marked on its picture, beside its languages (each added, replaced or taken away from a JSON file), its status and its history. **New upload** takes the picture and a file for each language, named by it (`he.json`, `en.json`…), or a whole upload as the API takes it, and draws the slide, or the template's sample, before anything is sent. A click on the slide places the subject's point. What the server finds wrong is shown by language.

An upload waits (`pending`) while it is written. It is then `accepted` or `rejected` (with a note), and an accepted one is `published` once the library has it. An upload is checked once more, against the library as it is then, when it is accepted, and it records who did each of these in its `history`. What does not hold is answered `422`, with every issue at its place: `{ "error": "invalid", "message", "issues": [{ "path": "languages.ja.slide", "message", "language": "ja" }] }`.

**Who may upload.** The permissions are being built apart: signing in, and the accounts the library names. Until they come, anyone who reaches the Worker may do everything, and each upload records `anyone`; so is the published Worker, once this is on `main`. They come in at one place, `worker/uploads/access.ts`, where each route names what it is about to do (`read`, `upload`, `review`, `publish`). A program that uploads, such as the studio or a script, signs in with a key of its own rather than a cookie.

**Into the library.** Taking accepted uploads into a publication is still to come. That publication is the studio's, which already publishes into `managed.json` and the templates' samples: it is to read `GET /api/uploads?status=accepted` and each upload's content and files, write them into the author's copy as it writes its own, and once the library has them, set each one `published`.

## Publishing

The page runs on Cloudflare as the Worker `library` (https://library.slidr.workers.dev), which serves the page built into `dist/client` and answers the uploads' API (`wrangler.jsonc`). `.github/workflows/deploy.yml` checks, builds and publishes it on every push to `main`, and you can run it by hand from the Actions tab. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To publish from your own machine: `pnpm build`, then `npx wrangler deploy`.

The uploads are kept in the R2 bucket `slidr-library-uploads`, which is made once, before the first publication: `npx wrangler r2 bucket create slidr-library-uploads`. They are checked against the published library, `https://slidr-media.pages.dev/`, unless the Worker's variable `MEDIA_LIBRARY_URL` names another. Checking an upload (a design in every language, a sample seated on its template) takes more CPU time than the Free plan's 10 ms a request, so the Worker runs on Workers Paid. `pnpm dev` runs the Worker beside the page, with a bucket of its own on this machine, in `.wrangler/`.

## Working on the page

`pnpm check` runs `typecheck`, `eslint` and `prettier`, and `pnpm test` the Worker's tests in Node (`worker/**/*.test.ts`; `worker/node.mjs` lets Node import the app's code in `vendor/` as a bundler does). The words of the page are in `src/i18n`: each area in Hebrew and English in `areas/<area>.ts`, and every other language in `locales/<lang>.ts`.
