import type { MessageKey } from './i18n';

/**
 * The parts of the media library the browser shows, in the order the app offers them, and the
 * files of each (docs/media-library.md), by which the overview counts them.
 */
export interface Section {
  id: string;
  /** The name, as a message to translate. */
  nameKey: MessageKey;
  /** What it is, in a line, as a message to translate. */
  aboutKey: MessageKey;
  /** The places of its files: a folder ends with a slash. */
  paths: string[];
}

/**
 * The files of art sets, each the set's drawings and its licence. A set is counted with the part
 * drawn from it (`ART` in the app's `elements/stickers.ts`), so no file is counted twice.
 */
const artSets = (...sets: string[]) => sets.map((set) => `elements/art/${set}.`);

export const SECTIONS: Section[] = [
  {
    id: 'designs',
    nameKey: 'library.section.designs.name',
    aboutKey: 'library.section.designs.about',
    paths: ['elements/designs/', 'images/designs/'],
  },
  {
    id: 'templates',
    nameKey: 'library.section.templates.name',
    aboutKey: 'library.section.templates.about',
    paths: ['templates/', 'images/templates/'],
  },
  {
    id: 'cards',
    nameKey: 'library.section.cards.name',
    aboutKey: 'library.section.cards.about',
    paths: ['elements/cards/'],
  },
  {
    id: 'frames',
    nameKey: 'library.section.frames.name',
    aboutKey: 'library.section.frames.about',
    paths: ['elements/catalogs/frames-catalog', 'images/frames/'],
  },
  {
    id: 'shapes',
    nameKey: 'library.section.shapes.name',
    aboutKey: 'library.section.shapes.about',
    paths: ['elements/catalogs/shapes.json'],
  },
  {
    id: 'graphics',
    nameKey: 'library.section.graphics.name',
    aboutKey: 'library.section.graphics.about',
    paths: [
      'elements/catalogs/graphics-catalog',
      ...artSets(
        'fluent-color',
        'fluent-emoji',
        'noto',
        'streamline-kameleon-color',
        'fluent-emoji-flat',
        'streamline-stickies-color',
        'streamline-ultimate-color',
        'streamline-emojis',
        'streamline-flex-color',
        'streamline-freehand-color',
      ),
    ],
  },
  {
    id: 'emoji',
    nameKey: 'library.section.emoji.name',
    aboutKey: 'library.section.emoji.about',
    paths: ['elements/catalogs/emoji-catalog', ...artSets('twemoji')],
  },
  {
    id: 'icons',
    nameKey: 'library.section.icons.name',
    aboutKey: 'library.section.icons.about',
    paths: ['icons/'],
  },
  {
    id: 'fonts',
    nameKey: 'library.section.fonts.name',
    aboutKey: 'library.section.fonts.about',
    paths: ['fonts/'],
  },
  {
    id: 'files',
    nameKey: 'library.section.files.name',
    aboutKey: 'library.section.files.about',
    paths: [''],
  },
];

export const sectionOf = (id: string) => SECTIONS.find((section) => section.id === id);

/** Whether a file of the library belongs to a section. */
export const inSection = (section: Section, path: string) =>
  section.paths.some((place) => path.startsWith(place));
