/**
 * Backgrounds and animations: the drawings of Elements that move by themselves (ADR-127 of the
 * app), the shapes that repeat a motion beside them (ADR-128), and the lines that something runs
 * along (ADR-131). The app drew them in its own code until they became the library's (ADR-138 of
 * the app): two catalogs, which publishing writes into and no script writes over, so a new item
 * is uploaded here as a design is.
 *
 *   elements/backgrounds/catalog.json   { version, backgrounds: [{ id, name, animated, sided,
 *                                         markup }] }
 *   elements/animations/catalog.json    { version, animations: [{ id, name, group, size, reads,
 *                                         markup or line }], shapes: [{ id, name, preset, side,
 *                                         aspect?, look, ink, ambient, reads? }] }
 *
 * An item is named in its catalog itself, in every language of the app: it is uploaded in Hebrew
 * and English, and accepted once it is named in all of them, as a design is written in all of
 * them. Its id is a word of its own in its list; an animation and an animated shape may share one,
 * as the hexagon does, since each is in a list of its own.
 *
 * A picture is SVG markup that the app draws as it is, so it is held to what a picture of a slide
 * may be before it is kept (`checkMarkup`): one drawing, moving by CSS or SMIL, that runs nothing
 * and reads nothing from outside itself. The app's renderer cleans it again when it draws it; this
 * check is of the string, so that what the library publishes needs no cleaning. Its colours are a
 * contract with the app, which maps those that stand for the theme's to the template's (`INK` of
 * the app's `motionKit.ts`); that is said, not checked, since any other colour stays as written.
 */
import {
  AmbientMotion,
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  LANGUAGE_NAMES,
  LineElement,
  LineFlow,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type ContentLanguage,
} from '@slidr/model';
import { z } from 'zod';
import { shapePresets } from '../../../vendor/packages/renderer/src/geometry.ts';
import { isRecord } from '../http.ts';
import {
  Issues,
  languagesToCheck,
  quote,
  unknownKeys,
  type Draft,
  type Field,
  type Handler,
} from './handler.ts';
import type { Library } from './library.ts';

/** Where the library keeps them, as the app reads them (`motionBackgrounds.ts`, `motionPieces.ts`). */
export const BACKGROUNDS = 'elements/backgrounds/catalog.json';
export const ANIMATIONS = 'elements/animations/catalog.json';

/** The lists of the catalogs, each of items with ids of their own. */
export type MotionList = 'backgrounds' | 'animations' | 'shapes';

/** Each catalog, and its lists in the order it holds them: a new catalog is these, empty. */
export const MOTION_CATALOGS: Readonly<Record<string, readonly MotionList[]>> = {
  [BACKGROUNDS]: ['backgrounds'],
  [ANIMATIONS]: ['animations', 'shapes'],
};

/** An item of each list, in words. */
export const MOTION_ITEM: Readonly<Record<MotionList, string>> = {
  backgrounds: 'a background',
  animations: 'an animation',
  shapes: 'an animated shape',
};

/** What an animation is: a picture that moves, a line that something runs along, or a shape. */
export const KINDS = ['picture', 'line', 'shape'] as const;
/** The groups the collection of the animations shows them in (`MOTION_GROUPS` of the app). */
export const GROUPS = ['path', 'spin', 'scale', 'lines', 'particles'] as const;
/** How an animated shape is painted, and in which colour of the theme (`motionShapes.ts`). */
const LOOKS = ['fill', 'outline', 'dashed'] as const;
const INKS = ['primary', 'secondary', 'accent'] as const;

/**
 * An id as the app's own are: a word in lowercase letters and digits, or in camelCase, as
 * `flowArrow`, and more joined by hyphens.
 */
const ID = /^[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*$/;
const ID_MOST = 40;
const NAME_MOST = 60;

/** The most a picture's markup holds, in bytes: the largest of the app's own are some 40 KB. */
export const MARKUP_BYTES = 256 * 1024;

/** The words a field is one of, as `Field.type` names them: `"fill" | "outline"`. */
const oneOf = (words: readonly string[]) => words.map((word) => `"${word}"`).join(' | ');

/** The list an upload's item goes into, and the catalog that holds it. */
export function placeOf(draft: Pick<Draft, 'type' | 'fields'>): { path: string; list: MotionList } {
  if (draft.type === 'backgrounds') return { path: BACKGROUNDS, list: 'backgrounds' };
  return { path: ANIMATIONS, list: draft.fields.kind === 'shape' ? 'shapes' : 'animations' };
}

/** The ids of a list of a catalog as the library has it; none when it has no catalog. */
export function idsIn(catalog: unknown, list: MotionList): Set<string> {
  const items = isRecord(catalog) && Array.isArray(catalog[list]) ? catalog[list] : [];
  return new Set(
    items.flatMap((item: unknown) =>
      isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
    ),
  );
}

/* ---------------------------------------------------------------- the schemas */

/**
 * An animation that is a line: a line of the deck, as a `LineElement` draws it, and what runs
 * along it (the app's `LineShape`), its points in the units of its size (`/api/schemas/line.json`).
 */
export const MotionLine = LineElement.pick({
  points: true,
  stroke: true,
  startHead: true,
  endHead: true,
  curve: true,
}).extend({ flow: LineFlow });

/**
 * An animated shape, as its catalog holds it but for its id and names (`/api/schemas/shape.json`):
 * a shape the renderer draws, its longest side on the slide, its proportions where they are its
 * own (its width over its height), how it is painted, and the motion it repeats (`AmbientMotion`).
 */
export const MotionShape = z.strictObject({
  preset: z.string().min(1),
  side: z.number().positive().max(SLIDE_HEIGHT),
  aspect: z.number().positive().optional(),
  look: z.enum(LOOKS),
  ink: z.enum(INKS),
  ambient: AmbientMotion,
  reads: z.boolean().optional(),
});

/* ---------------------------------------------------------------- the markup of a picture */

/** The namespace of SVG, on the root. */
const XMLNS = /\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/;
const VIEW_BOX = /\sviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/;
/** A link of the markup, and what it names. */
const HREF = /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * What a picture of the library never holds, each said once, with the first place it holds it:
 * what runs a script or another document, and what reads a file from outside the picture.
 */
const NEVER: readonly [RegExp, (found: string) => string][] = [
  [
    /<script\b/i,
    () =>
      'The picture has a <script>: a picture of the library moves by CSS or SMIL, and runs nothing.',
  ],
  [
    /<foreignObject\b/i,
    () =>
      'The picture has a <foreignObject>: a picture of the library is SVG alone, with no HTML in it.',
  ],
  [
    /<(?:iframe|embed|object)\b/i,
    (found) =>
      `The picture embeds another document (${found}>): a picture of the library is one drawing.`,
  ],
  [
    /<image\b/i,
    () =>
      'The picture shows an image file (<image>): a picture of the library is drawn whole in its markup.',
  ],
  [
    /\son[a-z]+\s*=/i,
    (found) =>
      `The picture has an event attribute (${found.trim()}): a picture of the library runs nothing.`,
  ],
  [
    /javascript:/i,
    () => 'The picture names javascript:, which a picture of the library never does.',
  ],
  [
    /@import\b/i,
    () => 'The picture imports a stylesheet (@import): its styles are in its own <style>.',
  ],
  [
    /url\(\s*(?!["']?#)[^)]*\)?/i,
    (found) =>
      `The picture reads ${quote(found)} from outside itself: url() names only what the picture holds, as url(#glow).`,
  ],
  [
    /\sattributeName\s*=\s*["']?(?:xlink:)?href\b/i,
    () =>
      'The picture changes a link as it moves (attributeName="href"): its links are fixed, and name only what it holds.',
  ],
  [
    /\sdata-slidr-(?:motion|speed)\s*=/i,
    (found) =>
      `The picture names ${found.trim().replace(/\s*=$/, '')}: the app gives a picture of the library its motion's name and its speed itself.`,
  ],
];

/**
 * The issues of a picture's markup, at `markup`: one `<svg>` of SVG's namespace with a `viewBox`
 * of four numbers, its width and height above 0 (the units of `size`, where the picture has one),
 * at most `MARKUP_BYTES`, with nothing of `NEVER` in it, and links (`href`, `xlink:href`) only to
 * what it holds (`#…`). Whitespace around it is let be: publishing writes it without.
 */
export function checkMarkup(value: unknown, issues: Issues, size?: { w: number; h: number }) {
  const at = 'markup';
  if (typeof value !== 'string' || !value.trim()) {
    issues.add(at, 'The picture, as SVG markup: a string that is one <svg> element.');
    return;
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MARKUP_BYTES) {
    issues.add(
      at,
      `The picture is ${Math.ceil(bytes / 1024)} KiB of markup: at most ${MARKUP_BYTES / 1024} KiB.`,
    );
    return;
  }
  const markup = value.trim();
  const root = /^<svg(?=[\s>/])([^>]*)>/.exec(markup);
  if (!root || !markup.endsWith('</svg>')) {
    issues.add(
      at,
      'The picture is one <svg> element: its markup starts with <svg and ends with </svg>.',
    );
  } else {
    const attributes = root[1] ?? '';
    if (!XMLNS.test(attributes)) {
      issues.add(at, 'The <svg> names its namespace: xmlns="http://www.w3.org/2000/svg".');
    }
    const box = VIEW_BOX.exec(attributes);
    const numbers = (box?.[1] ?? box?.[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const [, , width = 0, height = 0] = numbers;
    if (numbers.length !== 4 || !numbers.every(Number.isFinite) || !(width > 0 && height > 0)) {
      issues.add(
        at,
        'The <svg> has a viewBox of four numbers, its width and height above 0, as viewBox="0 0 400 400".',
      );
    } else if (size && (width !== size.w || height !== size.h)) {
      issues.add(
        at,
        `The picture is drawn in ${width} × ${height} units (its viewBox), and its size is ${size.w} × ${size.h}: they are the same.`,
      );
    }
  }
  for (const [pattern, message] of NEVER) {
    const found = pattern.exec(markup);
    if (found) issues.add(at, message(found[0]));
  }
  for (const link of markup.matchAll(HREF)) {
    const target = link[1] ?? link[2] ?? link[3] ?? '';
    if (target.startsWith('#')) continue;
    issues.add(
      at,
      `The picture links to ${quote(target)}: a link of a picture of the library names only what it holds, as #path.`,
    );
    break;
  }
}

/** What the about of `markup` says of every picture: what it is, and the colours it is drawn in. */
const MARKUP_ABOUT =
  `SVG markup, at most ${MARKUP_BYTES / 1024} KiB: one <svg> with ` +
  '`xmlns="http://www.w3.org/2000/svg"` and a `viewBox`, which moves by itself with CSS ' +
  '`@keyframes` in its own `<style>` or with SMIL. No script, event attribute (`on…`), ' +
  '`foreignObject`, `iframe`, `embed`, `object` or `image`, and nothing read from outside it: ' +
  '`href` and `url()` name only what it holds (`#…`), and no `@import`. Its colours stand for ' +
  'the theme\'s, written as attribute values (`fill="#6c4cf1"`), never in its stylesheet: the ' +
  'app maps these to the template’s colours, so the drawing follows the template: `#6c4cf1` ' +
  'primary, `#2f6bff` secondary, `#f29a00` accent, `#15213f` text, `#ffffff` surface, ' +
  '`#fbf6ec` bg (the ground); `#fffffe` is light, white in every theme (a glint). Any other ' +
  'colour stays as written.';

/* ---------------------------------------------------------------- what both parts share */

/** What a language holds of either part: the item's name in it. */
const nameField: Field = {
  name: 'name',
  type: 'string',
  about: `Its name in this language, as Elements show it: 1 to ${NAME_MOST} characters.`,
  required: true,
};

/** Made in Hebrew and English, written in any language of the app, accepted once named in all. */
const LANGUAGES: Handler['languages'] = {
  required: BASE_LANGUAGES,
  allowed: CONTENT_LANGUAGES,
  complete: CONTENT_LANGUAGES,
};

const idAbout = (what: string, example: string) =>
  `The new ${what}'s id: a word in lowercase letters and digits, or in camelCase (\`flowArrow\`), ` +
  `and more joined by hyphens, in up to ${ID_MOST} characters, as \`${example}\`; not taken ` +
  `among the library's ${what}s.`;

/** The issues of the id of a new item: its form, and whether its list has it already. */
async function checkId(draft: Draft, library: Library, issues: Issues) {
  const id = draft.target;
  const { path, list } = placeOf(draft);
  if (!ID.test(id) || id.length > ID_MOST) {
    issues.add(
      'id',
      `An id is a word in lowercase letters and digits, or in camelCase, and more joined by hyphens, as comet, flowArrow or slow-orbit, in up to ${ID_MOST} characters.`,
    );
  } else if ((await library.has(path)) && idsIn(await library.json(path), list).has(id)) {
    issues.add('id', `The library has ${MOTION_ITEM[list]} ${id} already.`);
  }
}

/** The issues of the content of each language checked: the item's name, and nothing else. */
function checkNames(
  draft: Draft,
  only: readonly ContentLanguage[] | undefined,
  what: string,
  issues: Issues,
) {
  for (const [lang, part] of languagesToCheck(draft, only)) {
    const at = `languages.${lang}`;
    if (!isRecord(part)) {
      issues.add(at, 'The content of a language is an object: { "name": … }.', lang);
      continue;
    }
    for (const key of unknownKeys(part, ['name'])) {
      issues.add(
        `${at}.${key}`,
        `What a language holds of ${what} is its name, and no ${key}.`,
        lang,
      );
    }
    const name = typeof part.name === 'string' ? part.name.trim() : '';
    if (name.length === 0 || name.length > NAME_MOST) {
      issues.add(
        `${at}.name`,
        `Its name in ${LANGUAGE_NAMES[lang].english}, 1 to ${NAME_MOST} characters.`,
        lang,
      );
    }
  }
}

/** Fields that are not of what is uploaded, each said where it is. */
function notOf(fields: Draft['fields'], keys: readonly string[], why: string, issues: Issues) {
  for (const key of keys.filter((one) => Object.hasOwn(fields, one))) issues.add(key, why);
}

/* ---------------------------------------------------------------- backgrounds */

/** `backgrounds: add`: a new background. */
export const addBackground: Handler = {
  type: 'backgrounds',
  action: 'add',
  about:
    'A new background of Elements: a drawing over the whole slide, most of them moving. It joins ' +
    '`elements/backgrounds/catalog.json`, named in every language of the app.',
  id: idAbout('background', 'aurora'),
  fields: [
    {
      name: 'animated',
      type: 'boolean',
      about: 'Whether it moves; one that does not is a still drawing.',
      required: true,
    },
    {
      name: 'sided',
      type: 'boolean',
      about:
        'Whether it stands on one side of the slide, or runs one way across it: such a background ' +
        'is drawn for a deck that reads from the right, and the app mirrors it for a deck that ' +
        'reads from the left, away from where its text starts.',
      required: true,
    },
    {
      name: 'markup',
      type: 'SVG',
      about:
        `The picture, drawn over the whole slide, ${SLIDE_WIDTH} × ${SLIDE_HEIGHT} ` +
        `(\`viewBox="0 0 ${SLIDE_WIDTH} ${SLIDE_HEIGHT}"\`). ${MARKUP_ABOUT}`,
      required: true,
    },
  ],
  languages: LANGUAGES,
  languageFields: [nameField],
  files: [],
  async check(draft, library, only) {
    const issues = new Issues();
    await checkId(draft, library, issues);
    const { animated, sided, markup } = draft.fields;
    if (typeof animated !== 'boolean') issues.add('animated', 'Whether it moves: true or false.');
    if (typeof sided !== 'boolean') {
      issues.add(
        'sided',
        'Whether it stands on one side of the slide, or runs one way across it: true or false.',
      );
    }
    checkMarkup(markup, issues);
    checkNames(draft, only, MOTION_ITEM.backgrounds, issues);
    return issues.all;
  },
};

/* ---------------------------------------------------------------- animations */

/** A size of a picture or a line, in slide pixels within the slide; none for anything else. */
function sizeOf(value: unknown): { w: number; h: number } | undefined {
  if (!isRecord(value) || unknownKeys(value, ['w', 'h']).length > 0) return undefined;
  const { w, h } = value;
  return typeof w === 'number' &&
    typeof h === 'number' &&
    w > 0 &&
    h > 0 &&
    w <= SLIDE_WIDTH &&
    h <= SLIDE_HEIGHT
    ? { w, h }
    : undefined;
}

/** The issues of a picture or a line: its group, its size, which way it reads, and itself. */
function checkPiece(kind: 'picture' | 'line', fields: Draft['fields'], issues: Issues) {
  notOf(
    fields,
    kind === 'picture' ? ['line', 'shape'] : ['markup', 'shape'],
    kind === 'picture'
      ? 'A picture is its markup, and has no line or shape.'
      : 'A line is its line, and has no markup or shape.',
    issues,
  );
  if (!(GROUPS as readonly unknown[]).includes(fields.group)) {
    issues.add('group', `The group it is shown in: one of ${GROUPS.join(', ')}.`);
  }
  const size = sizeOf(fields.size);
  if (!size) {
    issues.add(
      'size',
      `Its size on the slide, { "w", "h" } in slide pixels, each above 0 and within ${SLIDE_WIDTH} × ${SLIDE_HEIGHT}.`,
    );
  }
  if (typeof fields.reads !== 'boolean') {
    issues.add(
      'reads',
      'Whether it runs from one side to the other, drawn from left to right: true or false.',
    );
  }
  if (kind === 'picture') {
    checkMarkup(fields.markup, issues, size);
    return;
  }
  if (fields.line === undefined) {
    issues.add(
      'line',
      'A line brings its line: { points, stroke, startHead, endHead, curve, flow }.',
    );
    return;
  }
  const line = MotionLine.safeParse(fields.line);
  if (!line.success) {
    issues.addSchema('line', line.error);
    return;
  }
  if (!size) return;
  line.data.points.forEach(({ x, y }, i) => {
    if (!(x >= 0 && x <= size.w && y >= 0 && y <= size.h)) {
      issues.add(
        `line.points.${i}`,
        `(${x}, ${y}) is outside its size, ${size.w} × ${size.h}: a line's points are within it.`,
      );
    }
  });
}

/** The shapes the renderer draws, and those of the library's catalog of shapes. */
async function presetsOf(library: Library): Promise<ReadonlySet<string>> {
  const path = 'elements/catalogs/shapes.json';
  const catalog = (await library.has(path)) ? await library.json<unknown>(path) : undefined;
  const more = isRecord(catalog) && isRecord(catalog.shapes) ? Object.keys(catalog.shapes) : [];
  return new Set([...shapePresets, ...more]);
}

/** The issues of an animated shape: a shape the app draws, in either direction where it reads. */
async function checkShape(fields: Draft['fields'], library: Library, issues: Issues) {
  notOf(
    fields,
    ['group', 'size', 'reads', 'markup', 'line'],
    'An animated shape is its shape, and says all it is there (shape.reads too).',
    issues,
  );
  if (fields.shape === undefined) {
    issues.add(
      'shape',
      'An animated shape brings its shape: { preset, side, aspect?, look, ink, ambient, reads? }.',
    );
    return;
  }
  const parsed = MotionShape.safeParse(fields.shape);
  if (!parsed.success) {
    issues.addSchema('shape', parsed.error);
    return;
  }
  const { preset, reads } = parsed.data;
  const presets = await presetsOf(library);
  if (!presets.has(preset)) {
    issues.add(
      'shape.preset',
      `${preset} is no shape the renderer draws, nor one of elements/catalogs/shapes.json.`,
    );
    return;
  }
  if (!reads) return;
  // A deck that reads from the right draws it pointing the other way (`motionShapePreset`).
  const other = preset.replace('Right', 'Left');
  if (other === preset) {
    issues.add(
      'shape.reads',
      `A shape that reads points to the right, its preset naming Right, as arrowRight: ${preset} does not.`,
    );
  } else if (!presets.has(other)) {
    issues.add(
      'shape.reads',
      `${preset} points to the right, but no shape ${other} points to the left, for a deck that reads from the right.`,
    );
  }
}

/** `animations: add`: a new animation, or a new animated shape. */
export const addAnimation: Handler = {
  type: 'animations',
  action: 'add',
  about:
    'A new animation of Elements: a picture that moves by itself, a line that something runs ' +
    'along, or a shape that repeats a motion. It joins `elements/animations/catalog.json`, the ' +
    'shape among its `shapes`, named in every language of the app.',
  id: idAbout('animation', 'comet') + ' An animated shape may share the id of an animation.',
  fields: [
    {
      name: 'kind',
      type: oneOf(KINDS),
      about:
        'What it is: `picture`, a drawing that moves by itself (an `svg` element, ADR-127 of the ' +
        'app); `line`, a line of the deck that something runs along (ADR-131); `shape`, a shape ' +
        'of the renderer that repeats a motion (ADR-128).',
      required: true,
    },
    {
      name: 'group',
      type: oneOf(GROUPS),
      about:
        'For a picture and a line: the group of the collection it is shown in. Not for a shape.',
      required: false,
    },
    {
      name: 'size',
      type: '{ w, h }',
      about:
        'For a picture and a line: the units it is drawn in, and the size it lands on a slide at, ' +
        `in slide pixels, each above 0 and within ${SLIDE_WIDTH} × ${SLIDE_HEIGHT}. A picture's ` +
        "`viewBox` is `0 0 w h`, and a line's points are within it. Not for a shape.",
      required: false,
    },
    {
      name: 'reads',
      type: 'boolean',
      about:
        'For a picture and a line: whether it runs from one side to the other, as an arrow does. ' +
        'It is drawn from left to right, and the app mirrors it in a deck that reads from the ' +
        'right. A shape says it in `shape.reads`.',
      required: false,
    },
    {
      name: 'markup',
      type: 'SVG',
      about:
        'For a picture: the picture, drawn in the units of `size`. The app gives it its ' +
        '`data-slidr-motion` attribute itself (and `data-slidr-speed`), so the markup has ' +
        `neither. ${MARKUP_ABOUT}`,
      required: false,
    },
    {
      name: 'line',
      type: 'Line',
      about:
        "For a line: the line of the deck it is (`/api/schemas/line.json`): a `LineElement`'s " +
        '`points` (within `size`, from left to right), `stroke`, `startHead`, `endHead` and ' +
        '`curve`, and its `flow`, what runs along it (`LineFlow`, ADR-131 of the app).',
      required: false,
    },
    {
      name: 'shape',
      type: 'AnimatedShape',
      about:
        'For a shape (`/api/schemas/shape.json`): `preset`, a shape the renderer draws ' +
        '(`shapePresets`) or one of `elements/catalogs/shapes.json`; `side`, its longest side ' +
        `on the slide in slide pixels, up to ${SLIDE_HEIGHT}; \`aspect\`, its width over its ` +
        "height where it is not the shape's own; `look`, " +
        `${oneOf(LOOKS)}; \`ink\`, the theme's ${oneOf(INKS)}; \`ambient\`, the motion it ` +
        "repeats (the model's `AmbientMotion`); and `reads`, whether it points the way a line " +
        'runs: its preset names `Right`, which the app makes `Left` in a deck that reads from the ' +
        'right.',
      required: false,
    },
  ],
  languages: LANGUAGES,
  languageFields: [nameField],
  files: [],
  async check(draft, library, only) {
    const issues = new Issues();
    await checkId(draft, library, issues);
    const { fields } = draft;
    const kind = fields.kind;
    if (kind === 'shape') await checkShape(fields, library, issues);
    else if (kind === 'picture' || kind === 'line') checkPiece(kind, fields, issues);
    else issues.add('kind', `What it is: one of ${KINDS.join(', ')}.`);
    checkNames(draft, only, MOTION_ITEM[placeOf(draft).list], issues);
    return issues.all;
  },
};
