/**
 * Templates: the built-in templates of decks. A template is drawn by a source file with the
 * template kit, and so it is not uploaded; its sample deck is written in more languages here. Each
 * is kept in `templates/catalog.json` (`samples[<template>].<language>`), which the app's
 * `export-templates.mjs` keeps when it writes the template again: it writes Hebrew and English
 * from the source, and those are not uploaded.
 *
 * A sample is checked as `export-templates.mjs` checks the languages it keeps: the template's own
 * engine seats it on the template's layouts (`sampleSlides`), and fails where a layout has no
 * place for what it says.
 */
import {
  BASE_LANGUAGES,
  CONTENT_LANGUAGES,
  ChartElement,
  ChartType,
  PlaceholderRole,
  RichText,
  Slide,
  languageDir,
} from '@slidr/model';
import { sampleSlides, type SampleSlide } from '@slidr/templates/builtin/kit';
import { z } from 'zod';
import { isRecord } from '../http.ts';
import {
  Issues,
  languagesToCheck,
  placeholderIn,
  unknownKeys,
  wordedOf,
  type Handler,
} from './handler.ts';

const OTHER_LANGUAGES = CONTENT_LANGUAGES.filter(
  (lang) => !(BASE_LANGUAGES as readonly string[]).includes(lang),
);

/** The slides a sample may have. */
const SLIDES_MOST = 40;

const RoleFill = z.union([
  RichText,
  z.strictObject({ assetId: z.string().min(1) }),
  z.strictObject({ imagePrompt: z.string().min(1) }),
]);

/** One slide of a sample, as `packages/templates/src/builtin/kit.ts` writes it (`SampleSlide`). */
const SampleSlideSchema = z.strictObject({
  layout: z.string().min(1),
  name: z.string().min(1),
  content: z.partialRecord(PlaceholderRole, z.union([RoleFill, z.array(RoleFill)])),
  chart: z
    .strictObject({
      chartType: ChartType,
      data: ChartElement.shape.data,
      title: z.string().optional(),
    })
    .optional(),
  table: z
    .strictObject({
      rows: z.array(z.array(z.string())),
      cols: z.array(z.number().positive()),
      rowHeight: z.number().positive(),
    })
    .optional(),
});

/** A template's sample deck in one language (`/api/schemas/sample.json`). */
export const Sample = z.array(SampleSlideSchema).min(1).max(SLIDES_MOST);

/** The pictures a sample's content names. */
function picturesOf(sample: readonly SampleSlide[]): string[] {
  return sample.flatMap((slide) =>
    Object.values(slide.content).flatMap((fill) =>
      (Array.isArray(fill) ? fill : [fill]).flatMap((one: unknown) =>
        isRecord(one) && typeof one.assetId === 'string' ? [one.assetId] : [],
      ),
    ),
  );
}

/** `translate`: a published template's sample deck, in one more language or again in one. */
export const translateTemplate: Handler = {
  type: 'templates',
  action: 'translate',
  about:
    "A published template's sample deck in a language other than Hebrew and English, which the " +
    "template's source writes. It goes into `templates/catalog.json`, beside the languages the " +
    'template has.',
  id: "The published template's id, as `zerem`.",
  fields: [],
  languages: { required: [], allowed: OTHER_LANGUAGES, complete: [] },
  languageFields: [
    {
      name: 'sample',
      type: 'SampleSlide[]',
      about:
        "The sample deck in this language: for each slide, the id of one of the template's layouts " +
        "(`layout`), its name, and what each role of the layout says (`content`), with a chart's " +
        "or a table's data. A picture is named by its asset id in `templates/pictures.json`.",
      required: true,
    },
  ],
  files: [],
  async check(draft, library, only) {
    const issues = new Issues();
    const template = await library.template(draft.target);
    if (!template) {
      issues.add('id', `The library has no template ${draft.target}.`);
      return issues.all;
    }
    const checked = languagesToCheck(draft, only);
    if (checked.length === 0) return issues.all;
    const pictures = await library.pictures();
    const layouts = new Set(template.layouts.map((layout) => layout.id));
    for (const [lang, part] of checked) {
      const at = `languages.${lang}`;
      if (!isRecord(part)) {
        issues.add(at, 'The content of a language is an object.', lang);
        continue;
      }
      for (const key of unknownKeys(part, ['sample'])) {
        issues.add(`${at}.${key}`, `A sample in a language has no field ${key}.`, lang);
      }
      const parsed = Sample.safeParse(part.sample);
      if (!parsed.success) {
        issues.addSchema(`${at}.sample`, parsed.error, lang);
        continue;
      }
      const sample = parsed.data as SampleSlide[];
      const before = issues.all.length;
      sample.forEach((slide, index) => {
        if (!layouts.has(slide.layout)) {
          issues.add(
            `${at}.sample.${index}.layout`,
            `${template.theme.id} has no layout ${slide.layout}; its layouts are ${[...layouts].join(', ')}.`,
            lang,
          );
        }
      });
      for (const id of picturesOf(sample).filter((one) => !pictures.has(one))) {
        issues.add(`${at}.sample`, `No picture of the templates has the id ${id}.`, lang);
      }
      if (issues.all.length > before) continue;

      // Seated by the template's own engine, as the app shows it.
      const assets = Object.fromEntries(pictures);
      let slides: Slide[];
      try {
        slides = sampleSlides({ ...template, assets }, sample, { dir: languageDir(lang), lang });
      } catch (error) {
        issues.add(
          `${at}.sample`,
          `The template cannot show it: ${(error as Error).message}.`,
          lang,
        );
        continue;
      }
      slides.forEach((slide, index) => {
        const parsed = Slide.safeParse(slide);
        if (!parsed.success) issues.addSchema(`${at}.sample.${index}`, parsed.error, lang);
      });
      const placeholder = placeholderIn(
        slides.flatMap((slide) => wordedOf(slide.elements).map(({ content }) => content)),
      );
      if (placeholder) {
        issues.add(`${at}.sample`, `"${placeholder}" stands for text never written.`, lang);
      }
    }
    return issues.all;
  },
};
