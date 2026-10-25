/**
 * The server runs in Node from its source, on a machine (`pnpm library`) and in its tests: Node
 * strips the types, but resolves imports as the web does. The app's code in vendor/ is written for
 * a bundler: it imports `./schema` for `./schema.ts` or `./schema/index.ts`. Here Node is taught
 * the same (`pnpm library` and `pnpm test` load this file first).
 */
import { registerHooks } from 'node:module';

const RELATIVE = /^\.\.?\//;
const UNRESOLVED = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!RELATIVE.test(specifier) || !UNRESOLVED.has(error?.code)) throw error;
      for (const ending of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(specifier + ending, context);
        } catch {
          // The next ending, then the first error.
        }
      }
      throw error;
    }
  },
});
