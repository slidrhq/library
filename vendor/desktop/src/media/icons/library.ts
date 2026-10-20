/**
 * The built-in icon library (SHP-07, GEN-09, ADR-051): Lucide and Tabler line icons
 * (a 24 by 24 box, strokes of width 2, round caps), plus Tabler's filled icons.
 *
 * Nothing of it is loaded when the app starts. The sets' data are megabytes of JSON, files of the
 * media library (`icons/`), read and parsed the first time something asks: a search, or a slide
 * whose HTML carries `data-icon`. Each file is read on its own, so drawing one Lucide icon does
 * not load Tabler. Without the library a read fails, and the icons panel says so; it is tried
 * again the next time something asks.
 */
import { lazyMediaJson, readMediaJson } from '@slidr/media-library';
import { CONTENT_LANGUAGES } from '@slidr/model';
import {
  buildIndex,
  englishQuery,
  hebrewToEnglish,
  searchIcons,
  type HebrewTags,
  type IconEntry,
  type IconSearchOptions,
  type IconSources,
  type Tags,
  type TagsOf,
} from './search';

/** An SVG element as the sets store it: its tag and its attributes. */
type IconNode = [tag: string, attributes: Record<string, string | number>];
type IconNodes = Readonly<Record<string, readonly IconNode[]>>;

const lucideNodes = lazyMediaJson<IconNodes>('icons/lucide/icon-nodes.json');
const tablerNodes = lazyMediaJson<IconNodes>('icons/tabler/tabler-nodes-outline.json');
const tablerFilledNodes = lazyMediaJson<IconNodes>('icons/tabler/tabler-nodes-filled.json');
const lucideTags = lazyMediaJson<IconSources['lucide']>('icons/lucide/tags.json');
const tablerIcons = lazyMediaJson<IconSources['tabler']>('icons/tabler/icons.json');
/** The app's dictionary: an English word to the Hebrew a user would type for it. */
export const hebrewTags = lazyMediaJson<HebrewTags>('icons/hebrew.json');

let english: Promise<Map<string, string>> | undefined;

/**
 * A Hebrew query as English words, through the icons' own dictionary: for the photo libraries,
 * which index English only. Null when there is nothing to translate, or a word is not known.
 */
export async function toEnglish(query: string): Promise<string | null> {
  english ??= hebrewTags().then(hebrewToEnglish);
  return englishQuery(query, await english);
}

/** The kinds of things the media library tags for the search, a file each: `tags/<kind>.json`. */
export const TAG_KINDS = [
  'icons',
  'graphics',
  'emoji',
  'frames',
  'shapes',
  'cards',
  'designs',
] as const;
export type TagKind = (typeof TAG_KINDS)[number];

/** The tags of a file as the search takes them: lists of words, and nothing else. */
export function tagsOf(value: unknown): TagsOf {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const words = (list: unknown) =>
    Array.isArray(list) ? list.filter((tag): tag is string => typeof tag === 'string') : [];
  const tags: Record<string, Tags> = {};
  for (const [key, own] of Object.entries(value as Record<string, unknown>)) {
    if (own === null || typeof own !== 'object') continue;
    const localized = own as Record<string, unknown>;
    tags[key] = { en: words(localized.en), he: words(localized.he) };
    for (const lang of CONTENT_LANGUAGES) {
      if (lang !== 'he' && lang !== 'en' && Object.hasOwn(localized, lang)) {
        tags[key][lang] = words(localized[lang]);
      }
    }
  }
  return tags;
}

const tagged = new Map<TagKind, Promise<TagsOf>>();

/**
 * The library's search tags of a kind (ADR-108), read the first time they are asked for. A library
 * without them has none, and its things are found by their names alone; a read that failed is
 * tried again the next time.
 */
export function searchTags(kind: TagKind): Promise<TagsOf> {
  let tags = tagged.get(kind);
  if (!tags) {
    tags = readMediaJson<{ tags?: unknown }>(`tags/${kind}.json`).then((file) => {
      if (!file) tagged.delete(kind);
      return tagsOf(file?.tags);
    });
    tagged.set(kind, tags);
  }
  return tags;
}

let index: Promise<IconEntry[]> | undefined;

/** The search index of the whole library, built on first use. */
export function iconIndex(): Promise<IconEntry[]> {
  index ??= Promise.all([lucideTags(), tablerIcons(), hebrewTags(), searchTags('icons')])
    .then(([lucide, tabler, hebrew, tags]) => buildIndex({ lucide, tabler, hebrew }, tags))
    .catch((error: unknown) => {
      index = undefined;
      throw error;
    });
  return index;
}

const escape = (value: string | number) =>
  String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** The attributes on the root of a line icon, as both sets draw one. */
const LINE =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const FILLED = 'fill="currentColor"';

function toSvg(nodes: readonly IconNode[], root: string): string {
  const body = nodes
    .map(
      ([tag, attributes]) =>
        `<${tag}${Object.entries(attributes)
          // React's `key` rides along in some sets' data.
          .filter(([name]) => name !== 'key')
          .map(([name, value]) => ` ${name}="${escape(value)}"`)
          .join('')}/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${root}>${body}</svg>`;
}

/**
 * The SVG markup of an icon, drawn in `currentColor`, or undefined when the library has no icon
 * by that id. An id is `<set>:<name>`; a bare name is taken as Lucide's.
 */
export async function iconMarkup(id: string): Promise<string | undefined> {
  const [first, second] = id.trim().toLowerCase().split(':');
  const [set, name] = second === undefined ? ['lucide', first ?? ''] : [first, second];
  if (!name || !/^[a-z0-9-]+$/.test(name)) return undefined;
  if (set === 'lucide') {
    const nodes = (await lucideNodes())[name];
    return nodes && toSvg(nodes, LINE);
  }
  if (set === 'tabler') {
    if (name.endsWith('-filled')) {
      const nodes = (await tablerFilledNodes())[name.slice(0, -'-filled'.length)];
      if (nodes) return toSvg(nodes, FILLED);
    }
    const nodes = (await tablerNodes())[name];
    return nodes && toSvg(nodes, LINE);
  }
  return undefined;
}

export interface FoundIcon {
  id: string;
  name: string;
  svg: string;
}

/** Icons for a query in Hebrew or English, best first, each with its markup. */
export async function findIcons(query: string, options: IconSearchOptions): Promise<FoundIcon[]> {
  const found = searchIcons(await iconIndex(), query, options);
  const drawn = await Promise.all(
    found.map(async ({ id, name }) => ({ id, name, svg: await iconMarkup(id) })),
  );
  return drawn.flatMap(({ id, name, svg }) => (svg ? [{ id, name, svg }] : []));
}

/** The common icons shown first, before the larger browse catalog. */
export const STARTERS = [
  'chart-line',
  'messages-square',
  'hand-heart',
  'folder-kanban',
  'mic-vocal',
  'screen-share',
  'receipt-text',
  'wallet-cards',
  'calendar-range',
  'map-pinned',
  'plane-takeoff',
  'heart-pulse',
  'brain',
  'tree-pine',
  'mountain-snow',
  'cloud-sun',
  'shield-lock',
  'user-shield',
  'cloud-upload',
  'monitor-smartphone',
  'pencil-sparkles',
  'book-open-text',
  'badge-percent',
  'flower-2',
  'ship-wheel',
  'star',
  'heart',
  'check',
  'lightbulb',
  'rocket',
  'target',
  'trending-up',
  'chart-column',
  'chart-pie',
  'users',
  'user',
  'handshake',
  'calendar',
  'clock',
  'map-pin',
  'globe',
  'mail',
  'phone',
  'message-circle',
  'megaphone',
  'shield-check',
  'lock',
  'key',
  'settings',
  'wrench',
  'cpu',
  'cloud',
  'database',
  'code',
  'smartphone',
  'laptop',
  'camera',
  'image',
  'video',
  'music',
  'book-open',
  'graduation-cap',
  'briefcase',
  'building',
  'banknote',
  'credit-card',
  'shopping-cart',
  'truck',
  'plane',
  'leaf',
  'sun',
  'zap',
  'flag',
  'award',
  'thumbs-up',
  'circle-check',
  'triangle-alert',
  'info',
  'arrow-right',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'plus',
  'search',
  'link',
] as const;

/** Five hundred more Lucide icons to browse without knowing a search term. */
const browseNames = lazyMediaJson<readonly string[]>('icons/browse.json');

/** The common filled icons shown first, from Tabler's filled set. */
const FILLED_STARTERS = [
  'presentation-analytics',
  'chart-donut',
  'chart-bubble',
  'message-chatbot',
  'medical-cross',
  'file-invoice',
  'file-check',
  'folder-open',
  'gift-card',
  'plane-arrival',
  'train',
  'basket',
  'building-broadcast-tower',
  'receipt-dollar',
  'car-4wd',
  'stars',
  'video-plus',
  'file-code',
  'battery-vertical',
  'bell-ringing-2',
  'cloud-data-connection',
  'keyframes',
  'phone-check',
  'shield-half',
  'chart-area-line',
  'star',
  'heart',
  'circle-check',
  'bulb',
  'check',
  'compass',
  'user',
  'calendar',
  'clock',
  'map-pin',
  'world',
  'mail',
  'phone',
  'message-circle',
  'shield-check',
  'lock',
  'key',
  'settings',
  'cloud',
  'camera',
  'photo',
  'briefcase',
  'flag',
  'award',
  'thumb-up',
  'alert-triangle',
  'info-circle',
  'bell',
  'bookmark',
  'home',
  'sun',
  'moon',
  'bolt',
  'flame',
  'leaf',
  'eye',
  'folder',
  'file',
  'pin',
  'tag',
  'gift',
  'trophy',
  'crown',
  'diamond',
  'circle',
  'square',
  'triangle',
  'hexagon',
  'shopping-cart',
  'car',
  'plane',
  'file-text',
  'location',
  'send',
  'book',
  'chart-pie',
  'database',
  'video',
  'microphone',
  'palette',
] as const;

/** Five hundred more Tabler icons to browse in the filled style. */
const filledBrowseNames = lazyMediaJson<readonly string[]>('icons/filled-browse.json');

/** Icons available before a search, with their markup; a name a set has dropped is left out. */
export async function starterIcons(style: 'line' | 'filled' = 'line'): Promise<FoundIcon[]> {
  const ids =
    style === 'line'
      ? [...STARTERS, ...(await browseNames())].map((name) => ({ id: `lucide:${name}`, name }))
      : [...FILLED_STARTERS, ...(await filledBrowseNames())].map((name) => ({
          id: `tabler:${name}-filled`,
          name: `${name}-filled`,
        }));
  const drawn = await Promise.all(
    ids.map(async ({ id, name }) => ({ id, name, svg: await iconMarkup(id) })),
  );
  return drawn.flatMap(({ id, name, svg }) => (svg ? [{ id, name, svg }] : []));
}
