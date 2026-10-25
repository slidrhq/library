/**
 * The library on a machine: one process that serves the built page (`dist/client`) and answers
 * the rest, under `/auth/`, `/api/` and `/media/`, with the library's server (`../../core`), as the
 * Worker does on Cloudflare.
 *
 * It listens on this machine only (`127.0.0.1`) unless told otherwise, and then only over TLS, or
 * behind a proxy that speaks it, at the address its settings name (docs/SPEC.md §5.1). It answers
 * only a request that names it as it is named: on this machine, by a name of this machine, so a
 * page of another site cannot reach it through a name of its own that it points here (DNS
 * rebinding).
 */
import { readFile, stat } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from '../../core/context.ts';
import { handle, isServed } from '../../core/index.ts';

export interface ServeOptions {
  context: Context;
  /** The built page. */
  client: string;
  host?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Behind a proxy that speaks TLS, which says where the request came to (`X-Forwarded-Host`). */
  behindProxy?: boolean;
  /** The address the library is reached at: its settings' `url`, needed beyond this machine. */
  url?: string;
}

export interface Serving {
  url: string;
  close(): Promise<void>;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5176;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const isLoopback = (host: string) => LOOPBACK.has(host);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const notFound = () =>
  new Response('Not found.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** A file of the page, or the folder's `index.html`; none when it is not there. */
async function fileAt(path: string): Promise<{ path: string; bytes: Buffer } | undefined> {
  try {
    const found = await stat(path);
    const file = found.isDirectory() ? join(path, 'index.html') : path;
    return { path: file, bytes: await readFile(file) };
  } catch {
    return undefined;
  }
}

/**
 * A file of the built page. An address that names no file, and has no extension, is a page of
 * the page's own (`/designs/…`): `index.html` answers it, as Cloudflare's assets do
 * (`not_found_handling: single-page-application`).
 */
export async function pageFile(request: Request, client: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return notFound();
  }
  const root = resolve(client);
  const target = resolve(root, `.${path}`);
  if (target !== root && !target.startsWith(root + sep)) return notFound();
  const found =
    (await fileAt(target)) ??
    (extname(path) === '' ? await fileAt(join(root, 'index.html')) : undefined);
  if (!found) return notFound();
  const headers = {
    'Content-Type': TYPES[extname(found.path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(found.bytes.length),
    // Vite names each built asset by its content; the page itself is read again each time.
    'Cache-Control': path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(found.bytes), { headers });
}

/** The origin a request came to, or none when it does not name the library as it is named. */
function originOf(request: IncomingMessage, options: ServeOptions): string | undefined {
  const named = request.headers.host;
  if (!named) return undefined;
  if (options.url && (options.tls || options.behindProxy)) {
    const own = new URL(options.url);
    const forwarded = options.behindProxy ? request.headers['x-forwarded-host'] : undefined;
    const names = [named, ...(Array.isArray(forwarded) ? forwarded : [forwarded])];
    return names.includes(own.host) ? own.origin : undefined;
  }
  const { hostname } = new URL(`http://${named}`);
  if (!isLoopback(hostname)) return undefined;
  return `${options.tls ? 'https' : 'http'}://${named}`;
}

/** A request of Node's as the web's. */
function toRequest(request: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(request);
  return new Request(new URL(request.url ?? '/', origin), {
    method,
    headers,
    body,
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** Writes an answer of the web's to Node's. */
async function send(response: ServerResponse, answer: Response, method: string) {
  response.statusCode = answer.status;
  for (const [name, value] of answer.headers) {
    if (name !== 'set-cookie') response.setHeader(name, value);
  }
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader('Set-Cookie', cookies);
  if (!answer.body || method === 'HEAD') {
    await answer.body?.cancel();
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(answer.body as never), response);
}

/** Starts the server; answers where it listens, and how to stop it. */
export async function serve(options: ServeOptions): Promise<Serving> {
  const host = options.host ?? DEFAULT_HOST;
  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    try {
      const origin = originOf(request, options);
      if (!origin) {
        await send(
          response,
          new Response('This server is not reached by that name.', { status: 421 }),
          method,
        );
        return;
      }
      const web = toRequest(request, origin);
      const reply = isServed(new URL(web.url).pathname)
        ? await handle(web, { ...options.context, clientAddress: request.socket.remoteAddress })
        : await pageFile(web, options.client);
      await send(response, reply, method);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end('The server failed to answer.');
      } else response.destroy();
    }
  };
  const server: Server = options.tls
    ? createHttpsServer(
        { cert: options.tls.cert, key: options.tls.key },
        (req, res) => void answer(req, res),
      )
    : createHttpServer((req, res) => void answer(req, res));
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? DEFAULT_PORT, host, () => done());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    url:
      options.url && (options.tls || options.behindProxy)
        ? options.url
        : `${options.tls ? 'https' : 'http'}://${shown}:${port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
