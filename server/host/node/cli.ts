/**
 * `pnpm library <command>`: the library on this machine (README, "Installing on a machine";
 * docs/SPEC.md §5.1).
 *
 *   init          installs a library into a data folder, its installer as its owner
 *   start         serves it, on http://127.0.0.1:5176 unless told otherwise
 *   login         prints a link that signs the owner in, once, on this machine
 *   seed          copies a published library into the library's empty media folder
 *   sign-in       names the provider everyone else signs in through, and its client
 *   vault rotate  seals every key of it again, under a new master key
 *
 * `--data <dir>` names the data folder of each; it is `SLIDR_LIBRARY_DATA`, or a folder of the
 * user's (`defaultDataDir`), unless named.
 */
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LINK_SECONDS, issueLocalLink } from '../../core/auth.ts';
import { writeConfig, type SignInSettings } from '../../core/config.ts';
import { ProviderUnreachable, isOneTenant, microsoftIssuer, saveSignIn } from '../../core/oidc.ts';
import { listPeople } from '../../core/people.ts';
import {
  LibraryError,
  contextOf,
  contextSource,
  defaultDataDir,
  install,
  markRunning,
  openLibrary,
  rotate,
  running,
  seed,
  sweeping,
} from './install.ts';
import { MEDIA_LIBRARY_URL } from '@slidr/media-library';
import { MasterKeyError, type MasterSource } from './master.ts';
import { DEFAULT_HOST, DEFAULT_PORT, isLoopback, serve } from './server.ts';

const CLIENT = fileURLToPath(new URL('../../../dist/client/', import.meta.url));

const USAGE = `pnpm library <command>

  init          [--data <dir>] --owner <email> [--media-path <dir> [--seed]] [--url <address>]
                [--master-key-file <file> | --master-key-env]
  start         [--data <dir>] [--port ${DEFAULT_PORT}] [--url <address>]
                [--host <address> (--tls-cert <file> --tls-key <file> | --behind-proxy)]
  login         [--data <dir>]
  seed          [--data <dir>] [--from <address>]   (the published library unless named)
  sign-in       google --client-id <id> [--allowed-domains <a.org,b.org>] [--data <dir>]
                microsoft --tenant <id> --client-id <id> [--allowed-domains …]
                oidc --issuer <address> --client-id <id> [--name <shown>] [--allowed-domains …]
                off
                (the client's secret is asked for, or read from standard input)
  vault rotate  [--data <dir>]`;

/**
 * Asks for a secret on the terminal, showing nothing of it; without a terminal, the first line of
 * standard input. Never from an option, which a shell keeps in its history.
 */
async function askSecret(question: string): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() || undefined;
  }
  process.stdout.write(question);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((done) => {
    let value = '';
    const finish = () => {
      input.off('data', read);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      done(value.trim() || undefined);
    };
    const read = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') {
          finish();
          process.exit(130);
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    input.on('data', read);
  });
}

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
      seed: { type: 'boolean' },
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
  if (values.seed && mediaPath) await seedFrom(installed.data, MEDIA_LIBRARY_URL);
  console.log('Start it: pnpm library start');
}

/** Seeds the library of a data folder from a published library, saying how far it got. */
async function seedFrom(data: string, from: string) {
  const library = await openLibrary(data);
  const done = await seed(await contextOf(library), from, (step) => {
    const failed = step.failed.length ? `, ${step.failed.length} failed` : '';
    console.log(`  ${step.present} of ${step.files} files${failed}`);
  });
  console.log(`Seeded the media folder with the library published ${done.published}.`);
}

async function seedCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { data: { type: 'string' }, from: { type: 'string' } },
  });
  await seedFrom(values.data ?? defaultDataDir(), values.from ?? MEDIA_LIBRARY_URL);
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
  const source = contextSource(library);
  const serving = await serve({
    context: source,
    mediaPath: '/media/',
    client: CLIENT,
    host,
    port,
    ...(tls ? { tls } : {}),
    behindProxy,
    ...(library.config.url ? { url: library.config.url } : {}),
  });
  console.log(`Slidr Library: ${serving.url}  (data: ${library.data})`);
  await markRunning(library.data, {
    url: serving.url,
    ...(serving.local ? { local: serving.local } : {}),
  });
  const jobs = sweeping(source);
  const stop = () => {
    jobs.stop();
    void serving
      .close()
      .then(() => markRunning(library.data, undefined))
      .then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function login(args: string[]) {
  const { values } = parseArgs({ args, options: { data: { type: 'string' } } });
  const library = await openLibrary(values.data ?? defaultDataDir());
  const owner = (await listPeople(library.state)).find((person) => person.role === 'owner');
  if (!owner) throw new LibraryError('The library names no owner.');
  const code = await issueLocalLink(await contextOf(library), owner.email);
  const runs = await running(library.data);
  const base = runs?.local ?? runs?.url ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}/`;
  console.log(
    `Open this on this machine, within ${LINK_SECONDS / 60} minutes, to sign ${owner.email} in (once):`,
  );
  console.log(`  ${new URL(`auth/local?code=${code}`, base).toString()}`);
  if (!runs) console.log('The library is not running: start it first (pnpm library start).');
}

async function signIn(args: string[]) {
  const [kind, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      data: { type: 'string' },
      'client-id': { type: 'string' },
      tenant: { type: 'string' },
      issuer: { type: 'string' },
      name: { type: 'string' },
      'allowed-domains': { type: 'string' },
    },
  });
  const library = await openLibrary(values.data ?? defaultDataDir());
  const ctx = await contextOf(library);
  if (kind === 'off') {
    await saveSignIn(ctx, undefined, undefined, 'cli');
    console.log('No one signs in through a provider now; the owner, by pnpm library login.');
    return;
  }
  if (kind !== 'google' && kind !== 'microsoft' && kind !== 'oidc') throw new LibraryError(USAGE);
  const clientId = values['client-id'];
  if (!clientId) throw new LibraryError('Name the client: --client-id <id>.');
  if (kind === 'microsoft' && !isOneTenant(values.tenant ?? '')) {
    throw new LibraryError(
      'Name the organization’s tenant: --tenant <its id, or its domain>. Through organizations or common, any tenant’s accounts would sign in.',
    );
  }
  const issuer =
    kind === 'microsoft'
      ? microsoftIssuer(values.tenant ?? '')
      : kind === 'oidc'
        ? values.issuer
        : undefined;
  if (kind === 'oidc' && !issuer) throw new LibraryError('Name the issuer: --issuer https://….');
  const allowedDomains = (values['allowed-domains'] ?? '')
    .split(/[\s,;]+/)
    .map((one) => one.trim().toLowerCase())
    .filter(Boolean);
  const settings: SignInSettings = {
    provider: kind,
    clientId,
    allowedDomains,
    ...(issuer ? { issuer } : {}),
    ...(values.name ? { name: values.name } : {}),
  };
  const secret = await askSecret('The client’s secret: ');
  if (!secret) throw new LibraryError('The client comes with its secret.');
  try {
    await saveSignIn(ctx, settings, secret, 'cli');
  } catch (error) {
    if (error instanceof ProviderUnreachable) throw new LibraryError(error.message);
    throw error;
  }
  const base =
    library.config.url ??
    (await running(library.data))?.url ??
    `http://${DEFAULT_HOST}:${DEFAULT_PORT}/`;
  console.log(`People sign in through ${kind} now.`);
  console.log(
    `Register this redirect URI with the client: ${new URL('auth/callback', base).toString()}`,
  );
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

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  init,
  start,
  login,
  seed: seedCommand,
  'sign-in': signIn,
  vault,
};

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
