import { mediaCatalog, readMediaJson } from '@slidr/media-library';
import type { Localized } from '@slidr/model';
import { isRecord, localizedName } from './motionPieces';

/*
 * The backgrounds of Elements (ADR-127): a drawing over the slide's ground (the background's
 * `elements`, ADR-125), most of them moving. They are the media library's, not the app's
 * (ADR-138): `elements/backgrounds/catalog.json`, read when they are first wanted, or while the
 * app is idle. Until it has come, and without it, there are no backgrounds to apply; a background
 * already on a slide is a picture of its own and is drawn as it is.
 *
 * Each is a whole picture of the slide, 1920 × 1080, in the colours that stand for the theme's
 * (`INK` in `motionKit.ts`). One that stands on one side of the slide, or runs one way across it
 * (`sided`), is drawn for a deck that reads from the right; a deck that reads from the left gets
 * it mirrored, away from where its text starts.
 */

export interface MotionBackground {
  id: string;
  /** Its name in each language the library writes it in, Hebrew and English at least. */
  name: Localized<string>;
  /** Whether it moves. */
  animated: boolean;
  /**
   * Whether it stands on one side of the slide, or runs one way across it, which changes with
   * the deck's direction.
   */
  sided: boolean;
  markup: string;
}

/** Where the library keeps the backgrounds. */
export const BACKGROUNDS_CATALOG = 'elements/backgrounds/catalog.json';

/**
 * The backgrounds of a catalog, in its order: each that has an id, its names in Hebrew and
 * English, its two flags and a picture. Anything else of the file is left out, so a catalog
 * written by a later library still gives what this app can draw.
 */
export function backgroundsOf(file: unknown): MotionBackground[] {
  const list = isRecord(file) && Array.isArray(file.backgrounds) ? file.backgrounds : [];
  const seen = new Set<string>();
  return list.flatMap((item: unknown): MotionBackground[] => {
    if (!isRecord(item)) return [];
    const { id, animated, sided, markup } = item;
    const name = localizedName(item.name);
    if (
      typeof id !== 'string' ||
      !id ||
      seen.has(id) ||
      !name ||
      typeof animated !== 'boolean' ||
      typeof sided !== 'boolean' ||
      typeof markup !== 'string' ||
      !markup.startsWith('<svg')
    ) {
      return [];
    }
    seen.add(id);
    return [{ id, name, animated, sided, markup }];
  });
}

/** The backgrounds of the library, in the order the collection shows them. */
export const backgroundCatalog = mediaCatalog<readonly MotionBackground[]>(
  async () => backgroundsOf(await readMediaJson(BACKGROUNDS_CATALOG)),
  [],
);

/**
 * Every background the library has, as far as it has been read: none until the catalog has come.
 * What draws them draws again when it comes (`useMediaCatalog(backgroundCatalog)`).
 */
export function motionBackgrounds(): readonly MotionBackground[] {
  return backgroundCatalog.get();
}
