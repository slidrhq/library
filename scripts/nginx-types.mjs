/**
 * Writes `docker/media-types.conf`, the types the image's Nginx answers `/media/` with, from the
 * library's own (`pnpm nginx-types`; server/host/node/nginx.ts).
 */
import { writeFile } from 'node:fs/promises';
import { NGINX_TYPES_FILE, nginxTypes } from '../server/host/node/nginx.ts';

await writeFile(NGINX_TYPES_FILE, nginxTypes());
console.log(`Wrote ${NGINX_TYPES_FILE.pathname}`);
