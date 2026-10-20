# Slidr Library

A web page that shows the media library as it is published (docs/media-library.md of the app), as every installed app reads it. It only reads: changing the library goes through publishing, from [Slidr Studio](https://github.com/slidrhq/studio) or the app's `pnpm media:publish`. The page reads the site directly (`@slidr/media-library`), with no server of its own.

## Setup

```powershell
pnpm install
pnpm dev               # http://127.0.0.1:5176
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

## Publishing

The page runs on Cloudflare as the Worker `library` (https://library.slidr.workers.dev), which serves `dist/` (`wrangler.jsonc`). `.github/workflows/deploy.yml` checks, builds and publishes it on every push to `main`, and you can run it by hand from the Actions tab. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To publish from your own machine: `pnpm build`, then `npx wrangler deploy`.

## Working on the page

`pnpm check` runs `typecheck`, `eslint` and `prettier`. The words of the page are in `src/i18n`: each area in Hebrew and English in `areas/<area>.ts`, and every other language in `locales/<lang>.ts`.
