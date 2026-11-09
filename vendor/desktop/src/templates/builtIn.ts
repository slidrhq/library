/**
 * The templates Slidr ships with, as the library of the app takes them: read from the media
 * library once the app has started and is idle, or as soon as a panel that shows them is opened,
 * each from `templates/<id>/template.json` in the order of `templates/index.json`. The app never
 * waits for them to start. The library's publisher writes those files from its catalog
 * (`build/media.ts`). A file that is missing or is not a template is said to the console and left
 * out; without the library there are none, and the app goes on with the user's own templates.
 */
import { mediaCatalog, readMediaJson } from '@slidr/media-library';
import { templatePictures } from '@slidr/templates/builtin/pictures';
import { builtinFonts } from '../fonts/builtinFonts.generated';
import { Template } from '@slidr/templates';

async function read(id: string): Promise<Template | undefined> {
  const parsed = Template.safeParse(await readMediaJson(`templates/${id}/template.json`));
  if (parsed.success) return parsed.data;
  console.error(`The built-in template "${id}" could not be read`, parsed.error);
  return undefined;
}

async function load(): Promise<Template[]> {
  // After the fonts, which every slide is drawn in: on a slow network the templates, many times
  // their size, would otherwise hold them up.
  await builtinFonts.load();
  // With the pictures of their samples, which their covers show.
  const [ids] = await Promise.all([
    readMediaJson<unknown>('templates/index.json'),
    templatePictures.load(),
  ]);
  if (!Array.isArray(ids)) return [];
  const templates = await Promise.all(
    ids.filter((id): id is string => typeof id === 'string').map(read),
  );
  return templates.filter((template) => template !== undefined);
}

export const builtInTemplates = mediaCatalog<readonly Template[]>(load, []);
