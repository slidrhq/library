# Slidr Library

A web page that shows the media library as it is published (docs/media-library.md of the app), as every installed app reads it. It only reads: changing the library goes through publishing, from [Slidr Studio](https://github.com/slidrhq/studio) or the app's `pnpm media:publish`. The page reads the site directly (`@slidr/media-library`). Its own Worker only signs people in with a Google account, so that the people the library names can upload content to it later ([Signing in](#signing-in)).

## Setup

```powershell
pnpm install
pnpm dev               # http://127.0.0.1:5176, with the Worker
pnpm build; pnpm preview
```

`pnpm dev` and `pnpm preview` run the Worker inside Vite (`@cloudflare/vite-plugin`, in Cloudflare's own runtime), with the secrets of `.dev.vars`. Without that file the page works the same, and offers no signing in.

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

## Signing in

The button at the end of the top bar signs in with a Google account. Once signed in, it shows the account, and whether it may upload content to the library. Nothing is uploaded yet: this is what an upload will stand on.

- **How.** OpenID Connect's authorization code flow, with PKCE, a `state` and a `nonce` (`worker/auth.ts`). `/auth/login` sends the person to Google, Google sends them back to `/auth/callback`, and the Worker exchanges the code for the ID token with the client's secret. It checks the token's issuer, audience, expiry and nonce, and that the address is verified. Then it sends the person back to the page and the item they signed in from. A sign-in that fails comes back with `?signin=failed`, which the page shows and takes off the address.
- **The session** is a cookie signed with `SESSION_SECRET` (HMAC-SHA-256): `HttpOnly`, `SameSite=Lax`, `Secure` with the `__Host-` prefix over HTTPS, for 14 days. The Worker keeps no store. Changing `SESSION_SECRET` signs everyone out.
- **Who may upload** is `LIBRARY_EDITORS`: Google accounts by address, separated by commas. Anyone with a Google account can sign in, and only these may upload. The list is read on every request, so an address taken off it loses the right at once.
- **The routes** are the Worker's, ahead of the page's files (`assets.run_worker_first` in `wrangler.jsonc`): `GET /auth/login?return=<path>`, `GET /auth/callback`, `POST /auth/logout`, and `GET /api/me` (whether signing in is offered, and who is signed in). A route that will change the library, such as an upload, starts with `requireEditor(request, env)` of `worker/auth.ts`. That answers 401 without a session, and 403 for an account the list does not name or for a request from another site (its `Origin`).

### Setting it up

1. In the [Google Cloud console](https://console.cloud.google.com/auth/clients), make an OAuth client of the "Web application" type. Its authorized redirect URIs are `https://library.slidr.workers.dev/auth/callback`, and `http://127.0.0.1:5176/auth/callback` for `pnpm dev`. The consent screen asks for no more than `openid`, `email` and `profile`, which Google does not review. While the app is in "Testing", only its test users can sign in.
2. Give the Worker its secrets, once (they stay through every deploy):

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
   npx wrangler secret put LIBRARY_EDITORS     # you@example.com, someone@example.com
   ```

3. On this machine, copy `.dev.vars.example` to `.dev.vars` and fill it in. Git ignores it.

Until the Worker has its client and a `SESSION_SECRET` of at least 32 characters, `/api/me` says signing in is not offered, and the page shows no button.

## Publishing

The page runs on Cloudflare as the Worker `library` (https://library.slidr.workers.dev), which serves the page from `dist/client` and runs `worker/index.ts` (`wrangler.jsonc`; `pnpm build` writes both, and the Worker's own configuration to `dist/library`). `.github/workflows/deploy.yml` checks, tests, builds and publishes it on every push to `main`, and you can run it by hand from the Actions tab. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To publish from your own machine: `pnpm build`, then `npx wrangler deploy`.

## Working on the page

`pnpm check` runs `typecheck` (the page, and the Worker with `worker/tsconfig.json`), `eslint` and `prettier`. `pnpm test` runs the Worker's tests (`worker/*.test.ts`) in Node's test runner, with Google's token endpoint stood in for. The words of the page are in `src/i18n`: each area in Hebrew and English in `areas/<area>.ts`, and every other language in `locales/<lang>.ts`.
