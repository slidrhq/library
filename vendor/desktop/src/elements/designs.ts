import { readMediaJson } from '@slidr/media-library';
import {
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
  type SelectionStore,
  type Slide,
} from '@slidr/model';
import { searchTags } from '../media/icons/library';
import type { TagsOf } from '../media/icons/search';
import { designAssetUrl, previewAsset, previewBackdrop } from './designAssets';
import { designTagsOf, localName, mergeCatalogs, type DesignCatalog } from './designCatalog';
import { MANAGED_DESIGNS } from './managedDesigns';

/**
 * The ready-made slides: the catalog of the media library (`elements/designs/index.json`), and
 * after it the designs Slidr Studio publishes (`elements/designs/managed.json`). Slide
 * content is installed in media; this module only inserts it into a deck. Without the catalogs
 * the gallery has no designs to offer.
 */
const catalog = mergeCatalogs(
  await readMediaJson<Partial<DesignCatalog>>('elements/designs/index.json'),
  MANAGED_DESIGNS,
);
export type DesignGroup = string;
export type DesignId = string;
export const DESIGN_GROUPS: readonly DesignGroup[] = catalog.groups;
export const DESIGN_IDS: readonly DesignId[] = catalog.groups.flatMap(
  (group) => catalog.groupIds[group] ?? [],
);
export const DESIGN_SUBJECTS: Readonly<Record<string, [number, number]>> = catalog.subjects;
/** The designs of the catalog that came from `managed.json`. */
export const MANAGED_DESIGN_IDS: ReadonlySet<DesignId> = catalog.managed;

/** The name `managed.json` gives a managed design; the app's messages name the authored ones. */
export function designName(id: DesignId, lang: string): string | undefined {
  return localName(catalog.names.get(id), lang);
}

/** The name `managed.json` gives a group of designs, in the language of `lang`. */
export function designGroupName(group: DesignGroup, lang: string): string | undefined {
  return localName(catalog.groupNames.get(group), lang);
}

/**
 * The search tags of every design (ADR-108): the library's, with those `managed.json` gives the
 * designs of the studio. Read when a search first needs them; without them a design is found by
 * its name and its group's.
 */
export async function loadDesignTags(): Promise<TagsOf> {
  return designTagsOf(await searchTags('designs'), catalog.tags);
}

export function designsOf(group: DesignGroup): DesignId[] {
  return catalog.groupIds[group]?.slice() ?? [];
}

/** The languages a design is drawn in: Hebrew and English, and any its author added. */
export function designLanguages(id: DesignId): ContentLanguage[] {
  return languagesOf(catalog.slides[id] ?? {});
}

/** Whether a design is drawn in `lang`: an interface in that language offers only those. */
export const designIn = (id: DesignId, lang: string): boolean =>
  writtenIn(catalog.slides[id] ?? {}, lang) !== undefined;

/** The designs of a group drawn in `lang`, in their order. */
export const designsIn = (group: DesignGroup, lang: string): DesignId[] =>
  designsOf(group).filter((id) => designIn(id, lang));

/**
 * The language a deck in `lang` gets a design in: its own when the design is drawn in it, else
 * English, drawn left to right as it was composed.
 */
export function designLanguage(id: DesignId, lang: string): ContentLanguage {
  return pieceLanguage(catalog.slides[id] ?? {}, lang);
}

/** Each insertion gets new slide and element ids; the media file is never changed in place. */
export function designSlide(
  id: DesignId,
  lang: string,
  assetId: string,
  backdropId = assetId,
): Slide {
  const authored = catalog.slides[id]?.[designLanguage(id, lang)];
  if (!authored) throw new Error(`No design in media: ${id}`);
  const slide = duplicateSlide(createDeck({ slides: [authored] }), authored.id).slide;
  for (const element of walkElements(slide.elements)) {
    if (element.type !== 'image') continue;
    if (element.assetId === '__subject__') element.assetId = assetId;
    if (element.assetId === '__backdrop__') element.assetId = backdropId;
  }
  return slide;
}

/** The gallery renders the same slide model using image URLs in media. */
export function designPreview(id: DesignId, lang: string) {
  const asset = previewAsset(id);
  const backdrop = previewBackdrop(id);
  const slide = designSlide(id, lang, asset.id, backdrop?.id);
  const deck = createDeck({ lang: designLanguage(id, lang), slides: [slide] });
  deck.assets[asset.id] = asset;
  if (backdrop) deck.assets[backdrop.id] = backdrop;
  return { slide, deck, resolveAsset: designAssetUrl };
}

/**
 * Adds the imported pictures and a fresh slide together, in one undo step. The slide is the
 * design in `lang`, the language it was shown in, which need not be the deck's.
 */
export function insertDesign(
  bus: CommandBus,
  selection: SelectionStore,
  id: DesignId,
  lang: string,
  name: string,
  historyLabel: string,
  asset: AssetMeta,
  backdrop?: AssetMeta,
): Slide {
  const current = selection.getState().currentSlideId;
  const position = bus.deck.slides.findIndex((candidate) => candidate.id === current);
  const added = designSlide(id, lang, asset.id, backdrop?.id);
  added.name = name;
  const pictures = backdrop && backdrop.id !== asset.id ? [asset, backdrop] : [asset];
  const commands: Command[] = [
    ...pictures
      .filter((picture) => !bus.deck.assets[picture.id])
      .map((picture) => ({ type: 'asset.add' as const, asset: picture })),
    {
      type: 'slide.add',
      slide: added,
      index: position < 0 ? bus.deck.slides.length : position + 1,
    },
  ];
  bus.batch(commands, { label: historyLabel });
  selection.getState().setCurrentSlide(added.id);
  return added;
}
