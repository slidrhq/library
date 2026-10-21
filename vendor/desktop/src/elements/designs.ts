import { mediaManifest, readMediaJson } from '@slidr/media-library';
import {
  CONTENT_LANGUAGES,
  contentLanguageOf,
  createDeck,
  duplicateSlide,
  languagesOf,
  pieceLanguage,
  walkElements,
  writtenIn,
  type AssetMeta,
  type ContentLanguage,
  type Command,
  type CommandBus,
  type Deck,
  type Localized,
  type SelectionStore,
  type Slide,
} from '@slidr/model';
import { searchTags } from '../media/icons/library';
import type { TagsOf } from '../media/icons/search';
import { designAssetUrl, previewAsset, previewBackdrop } from './designAssets';
import {
  designTagsOf,
  localName,
  madeFrom,
  managedSize,
  mergeCatalogs,
  type DesignCatalog,
  type InLanguage,
  type ManagedDesignCatalog,
} from './designCatalog';

/**
 * The ready-made slides: the catalog of the media library (`elements/designs/index.json`), and
 * after it the designs Slidr Studio publishes (`elements/designs/managed.json`). Slide
 * content is installed in media; this module only inserts it into a deck. Without the catalogs
 * the gallery has no designs to offer.
 *
 * A gallery shows the designs of one language, and the catalogs hold every language, sixteen
 * times what it shows: so it reads them in its language, when it is first drawn (ADR-109).
 * Publishing writes each catalog again in each language (`elements/designs/<language>/`). A
 * library without those files, or whose files were not made from the catalogs it has, is read
 * whole, and what is not of the language is let go.
 */
export type DesignGroup = string;
export type DesignId = string;

/**
 * The designs as one reading of the catalogs has them: in one language, or in every one. Its
 * functions are of the reading, and may be taken apart from it.
 */
export interface Designs {
  readonly groups: readonly DesignGroup[];
  /** Every design, in the order the gallery shows them. */
  readonly ids: readonly DesignId[];
  readonly subjects: Readonly<Record<string, [number, number]>>;
  /** The designs that came from `managed.json`. */
  readonly managed: ReadonlySet<DesignId>;
  /** The name `managed.json` gives a managed design; the app's messages name the authored ones. */
  designName: (id: DesignId, lang: string) => string | undefined;
  /** The name `managed.json` gives a group of designs, in the language of `lang`. */
  designGroupName: (group: DesignGroup, lang: string) => string | undefined;
  /**
   * The search tags of every design (ADR-108): the library's, with those `managed.json` gives the
   * designs of the studio. Read when a search first needs them; without them a design is found by
   * its name and its group's.
   */
  loadDesignTags: () => Promise<TagsOf>;
  designsOf: (group: DesignGroup) => DesignId[];
  /**
   * The languages a design is drawn in: Hebrew and English, and any its author added. A reading
   * in one language knows them all, and has the slides of its own.
   */
  designLanguages: (id: DesignId) => ContentLanguage[];
  /** Whether a design is drawn in `lang`: an interface in that language offers only those. */
  designIn: (id: DesignId, lang: string) => boolean;
  /** The designs of a group drawn in `lang`, in their order. */
  designsIn: (group: DesignGroup, lang: string) => DesignId[];
  /**
   * The language a deck in `lang` gets a design in: its own when the design is drawn in it, else
   * English, drawn left to right as it was composed.
   */
  designLanguage: (id: DesignId, lang: string) => ContentLanguage;
  /** Each insertion gets new slide and element ids; the media file is never changed in place. */
  designSlide: (id: DesignId, lang: string, assetId: string, backdropId?: string) => Slide;
  /** The record of a design's picture, as the gallery draws it. */
  previewAsset: (id: DesignId) => AssetMeta;
  /** The record of a design's backdrop, when it has one. */
  previewBackdrop: (id: DesignId) => AssetMeta | undefined;
  /** The gallery renders the same slide model using image URLs in media. */
  designPreview: (
    id: DesignId,
    lang: string,
  ) => { slide: Slide; deck: Deck; resolveAsset: typeof designAssetUrl };
  /**
   * Adds the imported pictures and a fresh slide together, in one undo step. The slide is the
   * design in `lang`, the language it was shown in, which need not be the deck's.
   */
  insertDesign: (
    bus: CommandBus,
    selection: SelectionStore,
    id: DesignId,
    lang: string,
    name: string,
    historyLabel: string,
    asset: AssetMeta,
    backdrop?: AssetMeta,
  ) => Slide;
}

const CATALOGS = ['index.json', 'managed.json'] as const;
type CatalogName = (typeof CATALOGS)[number];

/** A catalog of designs, whole or in one language, as the library has it. */
type CatalogFile = Partial<ManagedDesignCatalog> & Partial<InLanguage>;

/** The designs of the two catalogs, and the languages each is drawn in, when they are known. */
function designsFrom(
  authored: Partial<DesignCatalog> | undefined,
  managed: Partial<ManagedDesignCatalog> | undefined,
  drawnIn?: Readonly<Record<string, readonly string[] | undefined>>,
): Designs {
  const catalog = mergeCatalogs(authored, managed);
  const slides: Readonly<Record<string, Partial<Localized<Slide>> | undefined>> = catalog.slides;
  const designsOf = (group: DesignGroup) => catalog.groupIds[group]?.slice() ?? [];
  const designLanguage = (id: DesignId, lang: string) => pieceLanguage(slides[id] ?? {}, lang);
  const designIn = (id: DesignId, lang: string) => writtenIn(slides[id] ?? {}, lang) !== undefined;
  const designSlide = (id: DesignId, lang: string, assetId: string, backdropId = assetId) => {
    const authoredSlide = slides[id]?.[designLanguage(id, lang)];
    if (!authoredSlide) throw new Error(`No design in media: ${id}`);
    const slide = duplicateSlide(createDeck({ slides: [authoredSlide] }), authoredSlide.id).slide;
    for (const element of walkElements(slide.elements)) {
      if (element.type !== 'image') continue;
      if (element.assetId === '__subject__') element.assetId = assetId;
      if (element.assetId === '__backdrop__') element.assetId = backdropId;
    }
    return slide;
  };
  const asset = (id: DesignId) => previewAsset(id, managedSize(managed, id));
  const backdrop = (id: DesignId) => previewBackdrop(id, managedSize(managed, `${id}-bg`));
  let tags: Promise<TagsOf> | undefined;

  return {
    groups: catalog.groups,
    ids: catalog.groups.flatMap((group) => catalog.groupIds[group] ?? []),
    subjects: catalog.subjects,
    managed: catalog.managed,
    designName: (id, lang) => localName(catalog.names.get(id), lang),
    designGroupName: (group, lang) => localName(catalog.groupNames.get(group), lang),
    loadDesignTags: () =>
      (tags ??= searchTags('designs').then((library) => designTagsOf(library, catalog.tags))),
    designsOf,
    designLanguages: (id) => {
      const listed = drawnIn?.[id];
      return listed
        ? CONTENT_LANGUAGES.filter((lang) => listed.includes(lang))
        : languagesOf(slides[id] ?? {});
    },
    designIn,
    designsIn: (group, lang) => designsOf(group).filter((id) => designIn(id, lang)),
    designLanguage,
    designSlide,
    previewAsset: asset,
    previewBackdrop: backdrop,
    designPreview: (id, lang) => {
      const picture = asset(id);
      const behind = backdrop(id);
      const slide = designSlide(id, lang, picture.id, behind?.id);
      const deck = createDeck({ lang: designLanguage(id, lang), slides: [slide] });
      deck.assets[picture.id] = picture;
      if (behind) deck.assets[behind.id] = behind;
      return { slide, deck, resolveAsset: designAssetUrl };
    },
    insertDesign: (bus, selection, id, lang, name, historyLabel, picture, behind) => {
      const current = selection.getState().currentSlideId;
      const position = bus.deck.slides.findIndex((candidate) => candidate.id === current);
      const added = designSlide(id, lang, picture.id, behind?.id);
      added.name = name;
      const pictures = behind && behind.id !== picture.id ? [picture, behind] : [picture];
      const commands: Command[] = [
        ...pictures
          .filter((one) => !bus.deck.assets[one.id])
          .map((one) => ({ type: 'asset.add' as const, asset: one })),
        {
          type: 'slide.add',
          slide: added,
          index: position < 0 ? bus.deck.slides.length : position + 1,
        },
      ];
      bus.batch(commands, { label: historyLabel });
      selection.getState().setCurrentSlide(added.id);
      return added;
    },
  };
}

/** What `elements/designs/revs.json` holds (`build/media.ts`, `designFiles`). */
export interface DesignRevs {
  /** The hash of each file the words were made from: the catalogs and the designs' pictures. */
  from: Record<string, string>;
  /** A word for each design in each language, of its slide and its pictures. */
  designs: Partial<Record<string, Record<string, string>>>;
}

let revs: Promise<DesignRevs | undefined> | undefined;

/**
 * The words of the designs (`revs.json`), when the publication that wrote them is the one the
 * library has: its catalogs and pictures are the ones they were made from. Undefined for a library
 * published without them.
 */
export function designRevs(): Promise<DesignRevs | undefined> {
  revs ??= Promise.all([
    readMediaJson<DesignRevs>('elements/designs/revs.json'),
    mediaManifest(),
  ]).then(([read, manifest]) => (read && madeFrom(read.from, manifest.files) ? read : undefined));
  return revs;
}

/** A catalog with the slides of `lang` alone, and the languages every design is drawn in. */
function onlyIn(whole: CatalogFile, lang: ContentLanguage): CatalogFile {
  const slides: Record<string, Partial<Localized<Slide>>> = {};
  const languages: Record<string, string[]> = {};
  for (const [id, variants] of Object.entries(whole.slides ?? {})) {
    if (variants === null || typeof variants !== 'object') continue;
    languages[id] = languagesOf(variants);
    const slide = variants[lang];
    if (slide) slides[id] = { [lang]: slide };
  }
  return { ...whole, slides, languages };
}

/**
 * A catalog in one language: the file the publisher wrote for it, else the whole catalog. A
 * publication that wrote the files of the languages (`written`) and none for this one has no
 * design of the catalog drawn in it.
 */
async function catalogIn(
  name: CatalogName,
  lang: ContentLanguage,
  files: Readonly<Record<string, { sha256: string } | undefined>>,
  written: boolean,
): Promise<CatalogFile | undefined> {
  const own = await readMediaJson<CatalogFile>(`elements/designs/${lang}/${name}`);
  if (own && madeFrom(own.from, files)) return own;
  if (written) return undefined;
  const whole = await readMediaJson<CatalogFile>(`elements/designs/${name}`);
  return whole && onlyIn(whole, lang);
}

async function readIn(lang: ContentLanguage): Promise<Designs> {
  const [{ files }, written] = await Promise.all([mediaManifest(), designRevs()]);
  const [authored, managed] = await Promise.all(
    CATALOGS.map((name) => catalogIn(name, lang, files, written !== undefined)),
  );
  // An id of both catalogs is the authored design, as `mergeCatalogs` keeps it.
  return designsFrom(authored, managed, { ...managed?.languages, ...authored?.languages });
}

const readings = new Map<ContentLanguage, Promise<Designs>>();

/**
 * The designs drawn in the language of `lang` (`he`, `pt-BR`), read once and kept: a language
 * the app has no content in has none. It never fails: a library it cannot read has no designs.
 */
export function loadDesigns(lang: string): Promise<Designs> {
  const language = contentLanguageOf(lang);
  if (!language) return Promise.resolve(designsFrom(undefined, undefined));
  let reading = readings.get(language);
  if (!reading) readings.set(language, (reading = readIn(language)));
  return reading;
}

let all: Promise<Designs> | undefined;

/** Every design in every language: the whole catalogs, for the tests and the review pages. */
export function loadAllDesigns(): Promise<Designs> {
  all ??= Promise.all(
    CATALOGS.map((name) => readMediaJson<CatalogFile>(`elements/designs/${name}`)),
  ).then(([authored, managed]) => designsFrom(authored, managed));
  return all;
}
