import { mediaFiles, mediaUrl, readMediaJson } from '@slidr/media-library';
import type { ContentLanguage } from '@slidr/model';
import { designRevs, type DesignId } from './designs';

/*
 * The pictures of the designs, made ahead (ADR-109). A design is a whole slide with a large
 * picture: drawn live, the first screens of the gallery read the full pictures of eighty designs
 * (12.9 MB, 108 megapixels to decode) and laid out their text in fonts read for it. So each
 * design has a picture of the renderer's own drawing in each of its languages, at two widths
 * (`scripts/generate-design-thumbs.mjs`): the gallery shows that, and the browser takes the width
 * the tile needs. A picture is of a word of the design (`elements/designs/revs.json`, written on
 * publishing). A design whose word has changed since, or that has no picture, is drawn live as
 * before.
 */

/** `images/designs/thumbs/index.json`: the widths, and the word each picture was drawn from. */
export interface DesignThumbsIndex {
  widths: number[];
  /** By language, then by design. */
  designs: Partial<Record<string, Record<string, string>>>;
}

/** A picture of a design made ahead, as an `img` takes it. */
export interface DesignThumb {
  /** The widest picture, for a browser that does not choose. */
  src: string;
  srcSet: string;
}

/** The picture of a design in a language, made ahead of it as it is now; undefined for none. */
export type FindDesignThumb = (id: DesignId, lang: ContentLanguage) => DesignThumb | undefined;

/** The place of a picture of a design in the library. */
export const designThumbPath = (width: number, lang: string, id: DesignId) =>
  `images/designs/thumbs/${width}/${lang}/${id}.webp`;

let thumbs: Promise<FindDesignThumb> | undefined;

/** How to find the pictures of the designs, read once. A library without them has none. */
export function loadDesignThumbs(): Promise<FindDesignThumb> {
  thumbs ??= Promise.all([
    readMediaJson<Partial<DesignThumbsIndex>>('images/designs/thumbs/index.json'),
    designRevs(),
    mediaFiles(),
  ]).then(([index, revs, files]) => {
    const widths = (Array.isArray(index?.widths) ? index.widths : [])
      .filter((width) => Number.isInteger(width) && width > 0)
      .sort((a, b) => a - b);
    return (id, lang) => {
      const word = revs?.designs[lang]?.[id];
      if (!word || index?.designs?.[lang]?.[id] !== word) return undefined;
      const paths = widths.map((width) => designThumbPath(width, lang, id));
      if (paths.length === 0 || !paths.every((path) => files.has(path))) return undefined;
      return {
        src: mediaUrl(paths.at(-1)!),
        srcSet: paths.map((path, at) => `${mediaUrl(path)} ${widths[at]}w`).join(', '),
      };
    };
  });
  return thumbs;
}
