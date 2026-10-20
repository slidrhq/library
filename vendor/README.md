# The app's code

The files of the app's repository ([slidrhq/app](https://github.com/slidrhq/app)) this page uses, copied at their own paths, so the library is drawn by the app's own code and this repository stands on its own:

- `packages/` — `@slidr/model`, `@slidr/renderer`, `@slidr/templates` and `@slidr/media-library`, the files of them that are used; members of this workspace (`pnpm-workspace.yaml`).
- `apps/desktop/src/` — the app's readers of the media library, its words for its content, and its translations (`@desktop`, `src/app.ts`).
- `tsconfig.base.json` — the app's compiler options.

`FILES.txt` lists the files, and `COMMIT` the app's commit they were copied from. They are not edited here. To take a newer version of the app's code:

```powershell
pnpm vendor --from ../app     # any checkout of the app
pnpm install; pnpm check; pnpm build
```

A file the app's code comes to import is added to `FILES.txt` (the type check, or the build, names it).
