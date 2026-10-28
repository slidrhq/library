/**
 * The files of the library an archive brought in merges into, where it writes over every other
 * (`archive.ts`, README "Exporting and importing"): the catalogs a library's own publications
 * write into. What a library published of its own stays beside what the archive brings.
 *
 *   elements/designs/index.json        the catalog of the designs, a design at a time
 *   images/designs/sizes.json          the sizes of their pictures, a picture at a time
 *   images/designs/thumbs/index.json   what their pictures made ahead were drawn of, a slide at a time
 *   tags/<part>.json                   the search tags of a part, an item at a time
 *   templates/catalog.json             the samples of the templates, a language at a time
 *
 * And of an archive of a library of before: `elements/designs/managed.json`, the catalog of the
 * designs Slidr Studio made, is folded into the catalog, and its files of each language go.
 */

const MERGED = new Set([
  'elements/designs/index.json',
  'elements/designs/managed.json',
  'images/designs/sizes.json',
  'images/designs/thumbs/index.json',
  'templates/catalog.json',
]);

/** A file of `managed.json` in one language, of a library of before: not brought in. */
export const MANAGED_IN_LANGUAGE =
  /^elements\/designs\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?\/managed\.json$/;

/** Whether an archive merges a file into the library's, rather than writing it over. */
export const isMerged = (path: string) =>
  MERGED.has(path) || /^tags\/[a-z0-9-]+\.json$/.test(path) || MANAGED_IN_LANGUAGE.test(path);
