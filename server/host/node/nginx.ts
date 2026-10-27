/**
 * The types the image's Nginx answers `/media/` with (`docker/media-types.conf`), written from
 * the table the library's own server answers with (`MEDIA_TYPES` of `media/live.ts`), so the two
 * never part: `pnpm nginx-types` writes the file, and `nginx.test.ts` fails when it differs.
 */
import { MEDIA_TYPES } from '../../core/media/live.ts';

export const NGINX_TYPES_FILE = new URL('../../../docker/media-types.conf', import.meta.url);

export function nginxTypes(): string {
  const byType = new Map<string, string[]>();
  const charset = new Set<string>();
  for (const [extension, type] of Object.entries(MEDIA_TYPES)) {
    const [bare, ...rest] = type.split(';').map((part) => part.trim());
    if (rest.some((part) => /^charset=utf-8$/i.test(part))) charset.add(bare!);
    byType.set(bare!, [...(byType.get(bare!) ?? []), extension]);
  }
  return [
    '# The types /media/ answers with: written by `pnpm nginx-types` from MEDIA_TYPES of',
    '# server/core/media/live.ts, as the library’s own server answers. Not to be changed here.',
    'types {',
    ...[...byType].map(([type, extensions]) => `    ${type} ${extensions.join(' ')};`),
    '}',
    'default_type application/octet-stream;',
    'charset utf-8;',
    `charset_types ${[...charset].join(' ')};`,
    '',
  ].join('\n');
}
