import { mediaCatalog, mediaUrl, readMediaJson } from '@slidr/media-library';
import type { FontFamilyEntry } from '@slidr/model';

/*
 * The built-in fonts of decks (SPEC appendix B): the catalog of the media library
 * (`fonts/catalog.json`) and its files. The app starts without waiting for it: until it has come,
 * and without the library, there are none, text is set in the fonts of the system, and the font
 * lists offer those and the user's own. It is read as the app starts, and the faces are
 * registered as it comes (`registerBuiltinFonts`).
 */

export interface BuiltinFace {
  family: string;
  style: string;
  weight: string;
  url: string;
  unicodeRange?: string;
}

interface MediaFace extends Omit<BuiltinFace, 'url'> {
  path: string;
}

interface Catalog {
  families: FontFamilyEntry[];
  faces: MediaFace[];
}

export interface BuiltinFonts {
  families: readonly FontFamilyEntry[];
  faces: readonly BuiltinFace[];
}

const NONE: BuiltinFonts = { families: [], faces: [] };

/** The built-in fonts: none until the library's catalog has come. */
export const builtinFonts = mediaCatalog<BuiltinFonts>(async () => {
  const read = await readMediaJson<Partial<Catalog>>('fonts/catalog.json');
  const faces = Array.isArray(read?.faces) ? read.faces : [];
  return {
    families: Array.isArray(read?.families) ? read.families : [],
    faces: faces
      .filter((face) => typeof face.path === 'string')
      .map(({ path, ...face }) => ({ ...face, url: mediaUrl(path) })),
  };
}, NONE);

/** The built-in families known now: none until the catalog has come. */
export const builtinFamilies = (): readonly FontFamilyEntry[] => builtinFonts.get().families;

/** The built-in faces, once the catalog has come: for a page that must have them before it draws. */
export const builtinFaces = async (): Promise<readonly BuiltinFace[]> =>
  (await builtinFonts.load()).faces;
