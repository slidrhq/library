/**
 * `slidr-library <command>`: a local library (README, "A local library"; docs/SPEC.md §5.1). The
 * image runs it as `slidr-library`, and the command of the machine reaches it through
 * `docker compose exec`; from the source, for working on the code, it is `pnpm library`.
 *
 *   init          installs a library into a data folder, its installer as its owner
 *   start         serves it, on http://127.0.0.1:5176 unless told otherwise
 *   login         prints a link that signs the owner in, once
 *   seed          copies a published library into the library's empty media folder
 *   import        brings an archive of the library (.tar, .tgz) into its media folder
 *   sign-in       names the provider everyone else signs in through, and its client
 *   owner         hands the library to another member
 *   status        where the library is, whether it runs, and a test of its media
 *   vault rotate  seals every key of it again, under a new master key
 *
 * `--data <dir>` names the data folder of each; it is `SLIDR_LIBRARY_DATA` (`/library/data` in
 * the image), or a folder of the user's (`defaultDataDir`), unless named.
 */
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LINK_SECONDS, issueLocalLink } from '../../core/auth.ts';
import { writeConfig, type SignInSettings } from '../../core/config.ts';
import { handOwnership } from '../../core/members.ts';
import { ProviderUnreachable, isOneTenant, microsoftIssuer, saveSignIn } from '../../core/oidc.ts';
import { emailOf, isEmail, listPeople } from '../../core/people.ts';
import { testStore } from '../../core/settings.ts';
import {
  LibraryError,
  contextOf,
  defaultDataDir,
  importFile,
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

/**
 * The built page: `LIBRARY_CLIENT` in the image, whose server is one file of its own
 * (`dist/node/library.mjs`); else beside the source.
 */
const CLIENT =
  process.env.LIBRARY_CLIENT ?? fileURLToPath(new URL('../../../dist/client/', import.meta.url));

const USAGE = `slidr-library <command>

  init          [--data <dir>] --owner <email> [--media <dir> [--seed]] [--url <address>]
                (--master-key-file <file> | --master-key-env)
  start         [--data <dir>] [--port ${DEFAULT_PORT}] [--url <address>]
                [--host <address> (--tls-cert <file> --tls-key <file> | --behind-proxy)]
  login         [--data <dir>]
  seed          [--data <dir>] [--from <address>]   (the published library unless named)
  import        <file.tgz | file.tar | -> [--data <dir>]   (an archive the page's Export wrote)
  sign-in       google --client-id <id> [--allowed-domains <a.org,b.org>] [--data <dir>]
                microsoft --tenant <id> --client-id <id> [--allowed-domains …]
                oidc --issuer <address> --client-id <id> [--name <shown>] [--allowed-domains …]
                off
                (the client's secret is asked for, or read from standard input)
  owner         <email> [--data <dir>]
  status        [--data <dir>]
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
      media: { type: 'string' },
      url: { type: 'string' },
      'master-key-file': { type: 'string' },
      'master-key-env': { type: 'boolean' },
      seed: { type: 'boolean' },
    },
  });
  const data = values.data ?? defaultDataDir();
  const owner = values.owner ?? (await ask('Your email address, as the library’s owner: '));
  if (!owner) throw new LibraryError('Name the owner: --owner <email>.');
  const media = values.media ?? (await ask('The media folder (empty: not yet): '));
  if (values['master-key-file'] && values['master-key-env']) {
    throw new LibraryError('The master key is in a file or in LIBRARY_MASTER_KEY, not both.');
  }
  if (!values['master-key-file'] && !values['master-key-env']) {
    throw new LibraryError(
      'Name where the master key is kept, apart from the data folder: --master-key-file <file>, or --master-key-env.',
    );
  }
  const master: MasterSource = values['master-key-file']
    ? { file: values['master-key-file'] }
    : 'env';
  const installed = await install({
    data,
    owner,
    master,
    ...(media ? { media } : {}),
    ...(values.url ? { url: values.url } : {}),
  });
  for (const warning of installed.warnings) console.warn(`  ! ${warning}`);
  console.log(`Installed the library in ${installed.data}.`);
  console.log(`  owner:      ${installed.owner}`);
  console.log(`  master key: ${installed.master}`);
  if (values.seed && media) await seedFrom(installed.data, MEDIA_LIBRARY_URL);
}

/** Seeds the library of a data folder from a published library, saying how far it got. */
async function seedFrom(data: string, from: string) {
  const library = await openLibrary(data);
  const done = await seed(contextOf(library), from, (step) => {
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

async function importCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { data: { type: 'string' } },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (!file) {
    throw new LibraryError(
      'Name the archive: import <file.tgz>, or - to read it from standard input.',
    );
  }
  const library = await openLibrary(values.data ?? defaultDataDir());
  const done = await importFile(contextOf(library), file);
  console.log(
    `Brought in the archive of the library published ${done.from || 'at an unknown time'}:`,
  );
  console.log(
    `  ${done.files} files: ${done.added.length} added, ${done.changed.length} written over, ${done.same} the same`,
  );
  if (done.removed.length > 0) console.log(`  ${done.removed.length} taken away`);
  if (done.skipped.length > 0)
    console.log(`  ${done.skipped.length} left out: ${done.skipped.slice(0, 5).join(', ')}`);
  console.log(
    done.published
      ? `The library is published ${done.published}. Apps read it at their next start.`
      : 'The library had every file of it already: nothing changed.',
  );
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
  // The address is its host's: the install script names it, and names it again when it changes.
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
  const context = contextOf(library);
  const serving = await serve({
    context,
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
  const jobs = sweeping(() => Promise.resolve(context));
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

/** The address the library is reached at: its own, or where it runs on this machine. */
async function reachedAt(library: Awaited<ReturnType<typeof openLibrary>>) {
  const runs = await running(library.data);
  return {
    runs,
    base: library.config.url ?? runs?.url ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}/`,
  };
}

async function login(args: string[]) {
  const { values } = parseArgs({ args, options: { data: { type: 'string' } } });
  const library = await openLibrary(values.data ?? defaultDataDir());
  const owner = (await listPeople(library.state)).find((person) => person.role === 'owner');
  if (!owner) throw new LibraryError('The library names no owner.');
  const code = await issueLocalLink(contextOf(library), owner.email);
  const { runs, base } = await reachedAt(library);
  console.log(`Open this within ${LINK_SECONDS / 60} minutes to sign ${owner.email} in (once):`);
  console.log(`  ${new URL(`auth/local?code=${code}`, base).toString()}`);
  if (!runs) console.log('The library is not running: start it first.');
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
  const ctx = contextOf(library);
  if (kind === 'off') {
    await saveSignIn(ctx, undefined, undefined, 'cli');
    console.log('No one signs in through a provider now; the owner, by slidr-library login.');
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
  const { base } = await reachedAt(library);
  console.log(`People sign in through ${kind} now.`);
  console.log(
    `Register this redirect URI with the client: ${new URL('auth/callback', base).toString()}`,
  );
}

async function owner(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { data: { type: 'string' } },
    allowPositionals: true,
  });
  const [to] = positionals;
  if (!to || !isEmail(to)) throw new LibraryError('Name the new owner: owner <email>.');
  const library = await openLibrary(values.data ?? defaultDataDir());
  if (!(await handOwnership(library.state, emailOf(to), 'cli'))) {
    throw new LibraryError(`${to} is not a member: name them a reviewer or an admin first.`);
  }
  console.log(`${emailOf(to)} owns the library now.`);
}

/** A number of bytes, as people read it. */
const bytesShown = (bytes: number) => {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  let at = 0;
  let value = bytes;
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024;
    at += 1;
  }
  return `${at === 0 ? value : value.toFixed(1)} ${units[at]}`;
};

async function status(args: string[]) {
  const { values } = parseArgs({ args, options: { data: { type: 'string' } } });
  const library = await openLibrary(values.data ?? defaultDataDir());
  const ctx = contextOf(library);
  const { runs, base } = await reachedAt(library);
  console.log(`Slidr Library at ${base}`);
  console.log(`  running:    ${runs ? 'yes' : 'no'}`);
  console.log(`  data:       ${library.data}`);
  console.log(`  master key: ${library.keys.where}`);
  if (!ctx.media || !ctx.mediaFolder) {
    console.log('  media:      none');
    return;
  }
  const room = await ctx.mediaFolder.room().catch(() => undefined);
  console.log(`  media:      ${ctx.mediaFolder.path}`);
  if (room) console.log(`  room:       ${bytesShown(room.free)} free of ${bytesShown(room.size)}`);
  const test = await testStore(ctx.media);
  if (!test.wrote) {
    console.log(`  test:       failed: ${test.message ?? 'it could not be written to'}`);
    process.exitCode = 1;
  } else if (test.library) {
    console.log(
      `  test:       written to; the library published ${test.library.published}, ${test.library.files} files`,
    );
  } else console.log('  test:       written to; it holds no library yet (seed it)');
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
  import: importCommand,
  'sign-in': signIn,
  owner,
  status,
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
