/**
 * The image's health (its HEALTHCHECK): the library answers through Nginx, over TLS when Nginx
 * speaks it. Its own certificate is not checked here: this is the container asking itself.
 */
import { existsSync } from 'node:fs';
import { request as http } from 'node:http';
import { request as https } from 'node:https';

const tls = existsSync('/library/tls/cert.pem') && existsSync('/library/tls/key.pem');
const asked = (tls ? https : http)(
  { host: '127.0.0.1', port: 8080, path: '/api/me', rejectUnauthorized: false, timeout: 4000 },
  (answer) => {
    answer.resume();
    process.exit(answer.statusCode === 200 ? 0 : 1);
  },
);
asked.on('timeout', () => asked.destroy(new Error('timeout')));
asked.on('error', () => process.exit(1));
asked.end();
