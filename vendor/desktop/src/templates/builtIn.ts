/**
 * The templates Slidr ships with, as the library of the app takes them: read from the media
 * library as the app starts, each from `templates/<id>/template.json` in the order of
 * `templates/index.json`. The library's publisher writes those files from its catalog
 * (`build/media.ts`). A file that is missing or is not a template is said to the console and left
 * out; without the library there are none, and the app opens with the user's own templates.
 */
import { readMediaJson } from '@slidr/media-library';
import { Template } from '@slidr/templates';

async function read(id: string): Promise<Template | undefined> {
  const parsed = Template.safeParse(await readMediaJson(`templates/${id}/template.json`));
  if (parsed.success) return parsed.data;
  console.error(`The built-in template "${id}" could not be read`, parsed.error);
  return undefined;
}

async function load(): Promise<Template[]> {
  const ids = await readMediaJson<unknown>('templates/index.json');
  if (!Array.isArray(ids)) return [];
  const templates = await Promise.all(
    ids.filter((id): id is string => typeof id === 'string').map(read),
  );
  return templates.filter((template) => template !== undefined);
}

export const builtIn: readonly Template[] = await load();
