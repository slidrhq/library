/**
 * The sample decks of the built-in templates, as the library draws them under a template: the
 * slides the template was authored with, and where their pictures load from.
 *
 * The samples are read from the catalog of the media library when a template is first opened,
 * not with the app: the catalog holds every template with its samples, in Hebrew and in English
 * and in whatever other language a template's author wrote them (`@slidr/model` languages). So
 * nothing here imports `@slidr/templates/builtin`, whose catalog is read as it is imported.
 */
import { mediaFiles, mediaUrl, requireMediaJson } from '@slidr/media-library';
import {
  languagesOf,
  writtenIn,
  type AssetMeta,
  type ContentLanguage,
  type Deck,
  type Localized,
} from '@slidr/model';
import type { Template } from '@slidr/templates';
import { sampleDeck, type SampleSlide } from '@slidr/templates/builtin/kit';
import { pictures } from '@slidr/templates/builtin/pictures';

const files = await mediaFiles();

const urls = new Map<string, string>();
for (const picture of Object.values(pictures)) {
  const path = `images/templates/${picture.name}`;
  if (files.has(path)) urls.set(picture.id, mediaUrl(path));
}

const pictureAssets: Record<string, AssetMeta> = Object.fromEntries(
  Object.values(pictures).map((picture) => [picture.id, picture]),
);

/** Where a picture of the built-in samples loads from; undefined for any other asset. */
export function pictureUrl(asset: AssetMeta): string | undefined {
  return urls.get(asset.id);
}

type Samples = Record<string, Localized<SampleSlide[]>>;

let read: Promise<Samples> | undefined;

/** The samples of the catalog, by template id. Read once; a failed read is tried again. */
function samples(): Promise<Samples> {
  read ??= requireMediaJson<{ samples?: Samples }>('templates/catalog.json')
    .then((catalog) => catalog.samples ?? {})
    .catch((error: unknown) => {
      read = undefined;
      throw error;
    });
  return read;
}

/** Reads the catalog now, ahead of the first sample that is asked for. */
export async function readSamples(): Promise<void> {
  await samples();
}

/** The languages each built-in template's sample is written in, by template id. */
export async function sampleLanguages(): Promise<Record<string, ContentLanguage[]>> {
  return Object.fromEntries(
    Object.entries(await samples()).map(([id, written]) => [id, languagesOf(written)]),
  );
}

/**
 * The name of the slide the catalog gives a text layout nobody wrote a sample for
 * (`scripts/export-templates.mjs`): the app's own words, "Slide title" and no more.
 */
const UNWRITTEN = new Set(['כותרת השקף', 'Slide title']);

/**
 * Whether a sample slide shows the template as a finished slide. Not one of a layout the
 * library's template does not keep, which has nothing to be drawn on; not one that says only
 * the app's own words, which a template is given where its sample has no text slide; and not
 * one whose picture is only described, which would be drawn as an empty frame.
 */
function finished(slide: SampleSlide, template: Template): boolean {
  const layout = template.layouts.find((candidate) => candidate.id === slide.layout);
  if (!layout || UNWRITTEN.has(slide.name)) return false;
  return !Object.values(slide.content)
    .flat()
    .some((fill) => 'imagePrompt' in fill);
}

/**
 * The sample deck of a built-in template in the language and direction of `like`; undefined
 * when the catalog has no sample for it. `template` is the one the library holds, which comes
 * without the pictures of its sample.
 */
export async function builtInSampleDeck(template: Template, like: Deck): Promise<Deck | undefined> {
  const mine = (await samples())[template.theme.id];
  if (!mine) return undefined;
  // A deck in a language the sample is not written in is shown the English one as it was
  // written, left to right, and not English text in a mirrored layout.
  const own = writtenIn(mine, like.meta.lang);
  const written = own !== undefined;
  const slides = (own ? mine[own]! : mine.en).filter((slide) => finished(slide, template));
  if (slides.length === 0) return undefined;
  const assets = { ...pictureAssets, ...template.assets };
  return sampleDeck(
    { ...template, assets },
    slides,
    written ? { lang: like.meta.lang, dir: like.meta.dir } : { lang: 'en', dir: 'ltr' },
  );
}
