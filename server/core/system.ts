/**
 * The settings of the apps that read this library, for an organization's admins (README,
 * "System settings"): which agents the app offers and which it starts on, the agents of the
 * organization's own (a CLI of the app's custom agent protocol, docs/custom-agent-cli.md of the
 * app), the languages of its interface, web access, and the image providers and photo libraries.
 *
 *   GET    /api/settings/system      the settings published, or none
 *   PUT    /api/settings/system      { agents?, languages?, images?, stock? }: published at once
 *   DELETE /api/settings/system      none: every app goes by its own defaults
 *   PUT    /api/settings/system/packages/<sha256>
 *                                    an agent's package, a .zip, kept by its hash until the
 *                                    settings that name it are published
 *
 * They are one file of the media, `system/settings.json`, which installed apps read through the
 * media protocol as they read the rest of it: when they first start, and again at every start, in
 * the background, for the next one (ADR-117 and ADR-124 of the app). A change is a publication
 * like any other (`media/writing.ts`): kept in the history, recorded, and the cache emptied of
 * it. The media is public to whoever reads the library, so the file holds nothing secret, and no
 * person's address: an agent's `env` is shown to everyone who reads it.
 *
 * An agent of the organization's own may come as a package of the library (ADR-130 of the app): a
 * .zip of its program and every file it needs, which the app downloads from the library alone,
 * never from the internet, and unpacks into a folder of the agent's own, `%SLIDR_AGENT_DIR%` in
 * the agent's program, arguments and environment. The page sends the zip first, by its hash; the
 * settings name it (`install: { sha256, size }`), and publishing them writes it at
 * `system/agents/<id>.zip`, in the same publication. A package no agent names is taken away as
 * they are published.
 */
import { CONTENT_LANGUAGES } from '@slidr/model';
import { z } from 'zod';
import { audit } from './audit.ts';
import type { Context } from './context.ts';
import { json, jsonBody, problem } from './http.ts';
import { forgetLibrary } from './uploads/library.ts';
import { authorize, recordOf, type Actor } from './uploads/access.ts';
import type { Bucket } from './bucket.ts';
import { Lease, NotNow } from './media/lease.ts';
import { MOST_BYTES, Refused, stage, stagedKey } from './media/files.ts';
import { readBytes, readManifest, toBytes, toText, type Manifest } from './media/live.ts';
import { recordPublication, undo } from './media/publish.ts';
import { Writing } from './media/writing.ts';

export const SYSTEM_SETTINGS = 'system/settings.json';

/** Where the agents' packages are in the media: one for each agent, by its id. */
export const AGENT_PACKAGES = 'system/agents/';
export const packagePath = (id: string) => `${AGENT_PACKAGES}${id}.zip`;
/** The largest package: the largest file a publication takes. */
export const MOST_PACKAGE = MOST_BYTES;
/**
 * The folder the app unpacks an agent's package into, as its program, arguments and environment
 * name it (`%SLIDR_AGENT_DIR%`); the app sets it in the agent's environment too.
 */
export const AGENT_DIR = 'SLIDR_AGENT_DIR';
const AGENT_DIR_NAMED = new RegExp(`%${AGENT_DIR}%`, 'i');
const HASH = /^[0-9a-f]{64}$/;

/** The agents the app has of its own (`harness/registry.rs` of the app), in its order. */
export const AGENTS = [
  'claude-code',
  'codex-cli',
  'copilot-cli',
  'gemini-cli',
  'grok-cli',
] as const;
/** Its image providers (`image_providers/registry.rs`). */
export const IMAGE_PROVIDERS = ['codex-cli', 'openai-api'] as const;
/** Its photo libraries (`stock/registry.rs`). */
export const STOCK_SOURCES = ['unsplash', 'pexels'] as const;
/** The tints an agent's mark may take: the design system's tool tints. */
export const TONES = ['orange', 'green', 'blue', 'violet', 'teal', 'pink', 'rose'] as const;
/** What an agent's own id may not be: an id the app gives one of its own (custom-agent-cli §3). */
const RESERVED = new Set<string>([...AGENTS, 'openai-api', 'mock']);
/** What the app sets in an agent's environment itself (custom-agent-cli §4). */
const OWN_ENV = new Set(['SLIDR_PROTOCOL', 'SLIDR_MCP_TOKEN', AGENT_DIR]);

/** A program by its absolute path, which `%NAME%` of the environment may begin. */
const ABSOLUTE = /^[A-Za-z]:\\|^%[A-Za-z_][A-Za-z0-9_]*%[\\/]|^\//;
/** A program by its name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A program by its path within the agent's package, `bin\acme.exe`: no part of it leaves it. */
const WITHIN = /^[A-Za-z0-9][A-Za-z0-9._ -]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._ -]*)*$/;

/**
 * The program an agent runs: a native executable, by its absolute path (`%NAME%` of the
 * environment may begin it, as `%LOCALAPPDATA%\Acme\acme.exe`), or by its name, found where the
 * app finds the CLIs it installs; for an agent that comes as a package, by its path within it,
 * where a name is looked for first too. Not a `.cmd`, `.bat` or `.ps1`: the app stops a turn by
 * ending this one process, and a shim would leave the real CLI running.
 */
const command = z
  .string()
  .trim()
  .min(1)
  .max(260)
  .refine(
    (value) => ABSOLUTE.test(value) || NAME.test(value) || WITHIN.test(value),
    'A command is an absolute path, the name of a program, or a path within the agent’s package.',
  )
  .refine(
    (value) => !/\.(cmd|bat|ps1|vbs|js)$/i.test(value),
    'A command is a native executable: a script is run by its interpreter, named here, with the script in args.',
  );

/**
 * How the app installs the agent's CLI once the user approves: WinGet's package, npm's, or a
 * package of this library, downloaded from it alone.
 */
const install = z.union([
  z.object({
    winget: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/, 'A WinGet package is named by its id.'),
    /** The WinGet source it is in, when it is not the community's: the organization's own. */
    source: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
  }),
  z.object({
    npm: z
      .string()
      .regex(
        /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
        'An npm package is named by its name.',
      ),
  }),
  z.object({
    /** Where it is in the media, `system/agents/<id>.zip`: the server names it as it saves. */
    package: z.string().regex(/^system\/agents\/[a-z][a-z0-9-]{1,31}\.zip$/),
    sha256: z.string().regex(HASH, 'A package is named by its SHA-256, in hex.'),
    size: z.number().int().positive().max(MOST_PACKAGE),
  }),
]);

/** An agent of the organization's own: a CLI of the custom agent protocol. */
export const CustomAgent = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,31}$/, 'An id is lowercase letters, digits and -, 2 to 32 long.')
      .refine((id) => !RESERVED.has(id), 'This id is one of the app’s own agents.'),
    /** The name the app shows. */
    name: z.string().trim().min(1).max(40),
    /** One or two characters on its mark; without them, a terminal. */
    glyph: z
      .string()
      .trim()
      .refine((value) => [...value].length >= 1 && [...value].length <= 2, 'One or two characters.')
      .optional(),
    tone: z.enum(TONES).optional(),
    command,
    args: z.array(z.string().max(2000)).max(32).default([]),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(2000))
      .refine(
        (env) => Object.keys(env).every((name) => !OWN_ENV.has(name.toUpperCase())),
        'SLIDR_PROTOCOL, SLIDR_MCP_TOKEN and SLIDR_AGENT_DIR are the app’s to set.',
      )
      .default({}),
    install: install.optional(),
  })
  .superRefine((agent, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (agent.install && 'package' in agent.install) {
      if (agent.install.package !== packagePath(agent.id)) {
        issue(['install', 'package'], `The package of ${agent.id} is ${packagePath(agent.id)}.`);
      }
      return;
    }
    // What is within a package, or names its folder, needs a package.
    const folder = 'Only an agent installed from a package of the library has a folder of its own.';
    if (!ABSOLUTE.test(agent.command) && !NAME.test(agent.command)) {
      issue(['command'], 'A path within a package is for an agent installed from one.');
    } else if (AGENT_DIR_NAMED.test(agent.command)) issue(['command'], folder);
    agent.args.forEach((arg, index) => {
      if (AGENT_DIR_NAMED.test(arg)) issue(['args', index], folder);
    });
    for (const [name, value] of Object.entries(agent.env)) {
      if (AGENT_DIR_NAMED.test(value)) issue(['env', name], folder);
    }
  });
export type CustomAgent = z.infer<typeof CustomAgent>;

/** What is offered of one kind, and the one an app starts with: none named, all of them. */
const offer = <T extends z.ZodType<string>>(id: T) =>
  z.object({ offered: z.array(id).min(1).optional(), default: id.optional() }).default({});

const agentId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

export const SystemSettings = z
  .object({
    version: z.literal(1),
    /** When it was published. */
    updated: z.string(),
    agents: z
      .object({
        offered: z.array(agentId).min(1).optional(),
        default: agentId.optional(),
        custom: z.array(CustomAgent).max(16).default([]),
        /**
         * Web search and fetch for the agent: on by default, off by default, or never. None
         * named: on, and each user's to turn off.
         */
        webAccess: z.enum(['on', 'off', 'blocked']).optional(),
      })
      .default({ custom: [] }),
    languages: offer(z.enum(CONTENT_LANGUAGES)),
    images: offer(z.enum(IMAGE_PROVIDERS)),
    stock: offer(z.enum(STOCK_SOURCES)),
  })
  .superRefine((settings, ctx) => {
    const { agents } = settings;
    const custom = agents.custom.map((agent) => agent.id);
    custom.forEach((id, index) => {
      if (custom.indexOf(id) !== index) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', 'custom', index, 'id'],
          message: 'Two agents have this id.',
        });
      }
    });
    const known = new Set<string>([...AGENTS, ...custom]);
    agents.offered?.forEach((id, index) => {
      if (!known.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', 'offered', index],
          message: `No agent is ${id}.`,
        });
      }
    });
    const parts = [
      ['agents', agents.offered ?? [...known], agents.default],
      ['languages', settings.languages.offered, settings.languages.default],
      ['images', settings.images.offered, settings.images.default],
      ['stock', settings.stock.offered, settings.stock.default],
    ] as const;
    for (const [part, offered, chosen] of parts) {
      if (chosen !== undefined && offered && !offered.includes(chosen as never)) {
        ctx.addIssue({
          code: 'custom',
          path: [part, 'default'],
          message: 'The default is one of those offered.',
        });
      }
    }
  });
export type SystemSettings = z.infer<typeof SystemSettings>;

/** The settings the media holds; none when it holds none, or none this server can read. */
export async function readSystemSettings(ctx: Context): Promise<SystemSettings | undefined> {
  if (!ctx.media) return undefined;
  const bytes = await readBytes(ctx.media, SYSTEM_SETTINGS);
  if (!bytes) return undefined;
  try {
    const parsed = SystemSettings.safeParse(JSON.parse(toText(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The settings as the file holds them: what was given, without what defaults to nothing. */
export function encodeSystemSettings(settings: SystemSettings): string {
  const empty = (field: unknown) =>
    field === undefined ||
    (Array.isArray(field) && field.length === 0) ||
    (typeof field === 'object' && field !== null && Object.keys(field).length === 0);
  const part = (value: object) =>
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, f]) => !empty(f)),
    );
  const agents = part({
    ...settings.agents,
    custom: settings.agents.custom.map((agent) => part(agent)),
  });
  const file = part({
    version: settings.version,
    updated: settings.updated,
    agents,
    languages: part(settings.languages),
    images: part(settings.images),
    stock: part(settings.stock),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

const notLive = () =>
  problem(
    409,
    'not-live',
    'The library is not in its bucket yet: bring it in first (POST /api/library/import).',
  );

/** A package the settings name: where it goes in the media, and the agent's place among them. */
interface Package {
  path: string;
  sha256: string;
  size: number;
  /** The agent's index in `agents.custom`, where a package that is missing is said to be. */
  at: number;
}

/** The packages the settings name. */
function packagesOf(settings: SystemSettings): Package[] {
  return settings.agents.custom.flatMap((agent, at) =>
    agent.install && 'package' in agent.install
      ? [
          {
            path: agent.install.package,
            sha256: agent.install.sha256,
            size: agent.install.size,
            at,
          },
        ]
      : [],
  );
}

/** A package the settings name that was neither sent first nor is in the library. */
class PackageMissing extends Error {
  readonly at: number;

  constructor(at: number) {
    super('Send the package first (PUT /api/settings/system/packages/<sha256>).');
    this.at = at;
  }
}

/**
 * The bytes of a package: as it was sent first, or as the library has it under another path (an
 * agent whose id changed). Whether they were the ones sent.
 */
async function packageBytes(
  media: Bucket,
  state: Bucket,
  files: Manifest['files'],
  one: Package,
): Promise<{ bytes: Uint8Array; staged: boolean }> {
  const held = await state.get(stagedKey(one.sha256));
  if (held) {
    const bytes = new Uint8Array(await held.arrayBuffer());
    if (bytes.length === one.size) return { bytes, staged: true };
  }
  const same = Object.entries(files).find(
    ([path, entry]) =>
      path.startsWith(AGENT_PACKAGES) && entry.sha256 === one.sha256 && entry.size === one.size,
  );
  const bytes = same ? await readBytes(media, same[0]) : undefined;
  if (bytes) return { bytes, staged: false };
  throw new PackageMissing(one.at);
}

/**
 * Writes the settings into the media, or takes them away (`text` none), as one publication, with
 * the agents' packages they name; and takes away the packages they do not name. What it
 * published, or why it could not.
 */
async function publish(
  ctx: Context,
  actor: Actor,
  text: string | undefined,
  packages: Package[] = [],
) {
  if (!ctx.media || !ctx.state) {
    return problem(503, 'not-set-up', 'This server has no bucket for the library (MEDIA).');
  }
  const live = await readManifest(ctx.media);
  if (!live) return notLive();
  let lease: Lease;
  try {
    lease = await Lease.take(ctx.state, actor);
  } catch (error) {
    if (error instanceof NotNow) return problem(409, error.code, error.message);
    throw error;
  }
  try {
    // Read again under the lease: a publication may have ended just before it was taken.
    const current = (await readManifest(ctx.media)) ?? live;
    const writing = new Writing(ctx.media, ctx.state, lease, current);
    const staged: string[] = [];
    try {
      for (const one of packages) {
        if (current.manifest.files[one.path]?.sha256 === one.sha256) continue;
        const { bytes, staged: sent } = await packageBytes(
          ctx.media,
          ctx.state,
          current.manifest.files,
          one,
        );
        await writing.put(one.path, bytes, one.sha256);
        if (sent) staged.push(stagedKey(one.sha256));
      }
      const named = new Set(packages.map((one) => one.path));
      for (const path of Object.keys(current.manifest.files)) {
        if (path.startsWith(AGENT_PACKAGES) && !named.has(path)) await writing.remove(path);
      }
      if (text === undefined) await writing.remove(SYSTEM_SETTINGS);
      else await writing.put(SYSTEM_SETTINGS, toBytes(text));
      if (!writing.written) return undefined;
      await writing.finish();
    } catch (error) {
      await undo(writing);
      if (error instanceof NotNow) return problem(409, error.code, error.message);
      if (error instanceof PackageMissing) {
        return problem(422, 'not-staged', 'A package of an agent was not sent.', [
          { path: `agents.custom.${error.at}.install`, message: error.message },
        ]);
      }
      throw error;
    }
    if (staged.length > 0) await ctx.state.delete([...new Set(staged)]);
    const { published, added, changed, removed } = writing;
    forgetLibrary();
    const cache = ctx.purge ? await ctx.purge([...added, ...changed, ...removed]) : undefined;
    // Recorded as a publication of files, as an author's is (`files.ts`).
    const record = { added, changed, removed, same: [], ...(cache ? { cache } : {}) };
    await recordPublication(ctx.state, published, {
      kind: 'files',
      by: recordOf(actor),
      ...record,
    });
    return published;
  } finally {
    await lease.release();
  }
}

type Route = (request: Request, ctx: Context) => Promise<Response>;

const read: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  return json({ path: SYSTEM_SETTINGS, settings: (await readSystemSettings(ctx)) ?? null });
};

const save: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const given = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const parsed = SystemSettings.safeParse({
    ...withPackagePaths(given as Record<string, unknown>),
    version: 1,
    updated: new Date().toISOString(),
  });
  if (!parsed.success) {
    return problem(
      400,
      'bad-request',
      'These settings do not hold.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  const packages = packagesOf(parsed.data);
  const published = await publish(ctx, actor, encodeSystemSettings(parsed.data), packages);
  if (published instanceof Response) return published;
  await audit(ctx.state, {
    by: actor.id,
    action: 'settings.system',
    detail: {
      custom: parsed.data.agents.custom.map((agent) => agent.id),
      ...(packages.length > 0
        ? { packages: packages.map(({ path, sha256 }) => ({ path, sha256 })) }
        : {}),
    },
  });
  return json({ settings: parsed.data, ...(published ? { published } : {}) });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The settings as given, each agent's package at the path the library keeps it: the page sends a
 * package by its hash and size alone.
 */
function withPackagePaths(given: Record<string, unknown>): Record<string, unknown> {
  const { agents } = given;
  if (!isRecord(agents) || !Array.isArray(agents.custom)) return given;
  const custom = agents.custom.map((agent: unknown) =>
    isRecord(agent) &&
    typeof agent.id === 'string' &&
    isRecord(agent.install) &&
    'sha256' in agent.install
      ? { ...agent, install: { ...agent.install, package: packagePath(agent.id) } }
      : agent,
  );
  return { ...given, agents: { ...agents, custom } };
}

/** Whether `bytes` begin as a .zip file with a file in it does. */
const isZip = (bytes: Uint8Array) =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

/**
 * Keeps an agent's package by its hash until the settings that name it are published, as an
 * author's file is kept (`media/files.ts`).
 */
const stagePackage: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  if (!ctx.state) {
    return problem(503, 'not-set-up', 'This server has no bucket for the uploads (UPLOADS).');
  }
  const tooLarge = () =>
    problem(413, 'too-large', `A package is at most ${MOST_PACKAGE / 1024 / 1024} MiB.`);
  if (Number(request.headers.get('Content-Length') ?? 0) > MOST_PACKAGE) return tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MOST_PACKAGE) return tooLarge();
  if (!isZip(bytes)) return problem(415, 'not-a-zip', 'A package is a .zip file.');
  const sha256 = new URL(request.url).pathname.split('/').pop() ?? '';
  try {
    const staged = await stage(ctx.state, sha256, bytes);
    return json({ sha256: staged.sha256, size: staged.size });
  } catch (error) {
    if (error instanceof Refused) return problem(400, error.code, error.message);
    throw error;
  }
};

const remove: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  const published = await publish(ctx, actor, undefined);
  if (published instanceof Response) return published;
  await audit(ctx.state, { by: actor.id, action: 'settings.system.remove' });
  return new Response(null, { status: 204 });
};

export const SYSTEM_ROUTES: [RegExp, Partial<Record<string, Route>>][] = [
  [/^\/api\/settings\/system$/, { GET: read, PUT: save, DELETE: remove }],
  [/^\/api\/settings\/system\/packages\/[^/]+$/, { PUT: stagePackage }],
];
