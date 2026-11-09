import { mediaCatalog, readMediaJson } from '@slidr/media-library';
import type { AssetMeta } from '@slidr/model';

/**
 * The pictures of the built-in templates' samples, by id: `templates/pictures.json` of the media
 * library, which its publisher writes from the catalog. Read when they are first wanted, never as
 * the app starts; none until then, and none without the library.
 */
export const templatePictures = mediaCatalog<Readonly<Record<string, AssetMeta>>>(async () => {
  const read = await readMediaJson<Record<string, AssetMeta>>('templates/pictures.json');
  return read && typeof read === 'object' && !Array.isArray(read) ? read : {};
}, {});
