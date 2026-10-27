import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { MEDIA_TYPES } from '../../core/media/live.ts';
import { NGINX_TYPES_FILE, nginxTypes } from './nginx.ts';

describe('the types of the image’s Nginx', () => {
  test('are the library’s own: pnpm nginx-types writes them again when they part', async () => {
    assert.equal((await readFile(NGINX_TYPES_FILE, 'utf8')).replaceAll('\r\n', '\n'), nginxTypes());
  });

  test('name every extension, and a charset where the library’s server names one', () => {
    const written = nginxTypes();
    for (const [extension, type] of Object.entries(MEDIA_TYPES)) {
      const bare = type.split(';')[0]!;
      assert.match(
        written,
        new RegExp(`^ {4}${bare.replace('+', '\\+')} .*\\b${extension}\\b`, 'm'),
      );
      if (type.includes('charset')) assert.match(written, new RegExp(`charset_types .*${bare}`));
    }
  });
});
