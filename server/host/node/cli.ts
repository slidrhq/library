/**
 * `pnpm library <command>`: the library on this machine (README, "Installing on a machine";
 * docs/SPEC.md §5.1).
 *
 *   init          installs a library into a data folder, its installer as its owner
 *   start         serves it, on http://127.0.0.1:5176 unless told otherwise
 *   vault rotate  seals every key of it again, under a new master key
 *
 * `--data <dir>` names the data folder of each; it is `SLIDR_LIBRARY_DATA`, or a folder of the
 * user's (`defaultDataDir`), unless named.
 */
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeConfig } from '../../core/config.ts';
import {
  LibraryError,
  contextOf,
  defaultDataDir,
  install,
  openLibrary,
  rotate,
} from './install.ts';
import { MasterKeyError, type MasterSource } from './master.ts';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopback, serve } from './server.ts';

const CLIENT = fileURLToPath(new URL('../../../dist/client/', import.meta.url));

const USAGE = `pnpm library <command>

  init          [--data <dir>] --owner <email> [--media-path <dir>] [--url <address>]
                [--master-key-file <file> | --master-key-env]
  start         [--data <dir>] [--port ${DEFAULT_PORT}] [--url <address>]
                [--host <address> (--tls-cert <file> --tls-key <file> | --behind-proxy)]
  vault rotate  [--data <dir>]`;

/** Asks on the terminal; none when there is no one at it. */
async function ask(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

async function init(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      data: { type: 'string' },
      owner: { type: 'string' },
      'media-path': { type: 'string' },
      url: { type: 'string' },
      'master-key-file': { type: 'string' },
      'master-key-env': { type: 'boolean' },
    },
  });
  const data = values.data ?? defaultDataDir();
  const owner = values.owner ?? (await ask('Your email address, as the library’s owner: '));
  if (!owner) throw new LibraryError('Name the owner: --owner <email>.');
  const mediaPath =
    values['media-path'] ?? (await ask('The folder of the media library (empty: not yet): '));
  if (values['master-key-file'] && values['master-key-env']) {
    throw new LibraryError('The master key is in a file or in LIBRARY_MASTER_KEY, not both.');
  }
  const master: MasterSource = values['master-key-file']
    ? { file: values['master-key-file'] }
    : values['master-key-env']
      ? 'env'
      : 'keychain';
  const installed = await install({
    data,
    owner,
    master,
    ...(mediaPath ? { media: { kind: 'folder' as const, path: mediaPath } } : {}),
    ...(values.url ? { url: values.url } : {}),
  });
  for (const warning of installed.warnings) console.warn(`  ! ${warning}`);
  console.log(`Installed the library in ${installed.data}.`);
  console.log(`  owner:      ${installed.owner}`);
  console.log(`  master key: ${installed.master}`);
  console.log('Start it: pnpm library start');
}

async function start(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      data: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      url: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'behind-proxy': { type: 'boolean' },
    },
  });
  const library = await openLibrary(values.data ?? defaultDataDir());
  if (values.url && values.url !== library.config.url) {
    library.config = { ...library.config, url: values.url };
    await writeConfig(library.state, library.config);
  }
  const host = values.host ?? DEFAULT_HOST;
  const tls =
    values['tls-cert'] || values['tls-key']
      ? {
          cert: await readFile(values['tls-cert'] ?? ''),
          key: await readFile(values['tls-key'] ?? ''),
        }
      : undefined;
  const behindProxy = values['behind-proxy'] ?? false;
  if (!isLoopback(host) && !tls && !behindProxy) {
    throw new LibraryError(
      `Beyond this machine (${host}), the library is reached over TLS only: --tls-cert and --tls-key, or --behind-proxy.`,
    );
  }
  if ((tls || behindProxy) && !library.config.url) {
    throw new LibraryError('Name the address the library is reached at: --url https://….');
  }
  try {
    await access(CLIENT);
  } catch {
    throw new LibraryError('The page is not built: pnpm build');
  }
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LibraryError(`${values.port} is not a port.`);
  }
  const serving = await serve({
    context: await contextOf(library),
    client: CLIENT,
    host,
    port,
    ...(tls ? { tls } : {}),
    behindProxy,
    ...(library.config.url ? { url: library.config.url } : {}),
  });
  console.log(`Slidr Library: ${serving.url}  (data: ${library.data})`);
  const stop = () => {
    void serving.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function vault(args: string[]) {
  const [what, ...rest] = args;
  if (what !== 'rotate') throw new LibraryError(USAGE);
  const { values } = parseArgs({ args: rest, options: { data: { type: 'string' } } });
  const library = await openLibrary(values.data ?? defaultDataDir());
  const names = await rotate(library);
  const keys = names.length === 1 ? 'key' : 'keys';
  console.log(`Sealed ${names.length} ${keys} under a new master key (${names.join(', ')}).`);
  // A server that runs holds the master key it started with.
  console.log('Start the library again if it runs.');
}

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { init, start, vault };

const [command = '', ...args] = process.argv.slice(2);
const run = COMMANDS[command];
if (!run) {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
} else {
  run(args).catch((error: unknown) => {
    if (error instanceof LibraryError || error instanceof MasterKeyError) {
      console.error(error.message);
    } else if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      console.error(`${error.message}\n\n${USAGE}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
