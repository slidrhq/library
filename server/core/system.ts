/**
 * The settings of the apps that read this library, for an organization's admins (README,
 * "System settings"): which agents the app offers and which it starts on, the agents of the
 * organization's own (a CLI of the app's custom agent protocol, docs/custom-agent-cli.md of the
 * app), the languages of its interface, web access, and the image providers and photo libraries.
 *
 *   GET    /api/settings/system      the settings published, or none
 *   PUT    /api/settings/system      { agents?, languages?, images?, stock? }: published at once
 *   DELETE /api/settings/system      none: every app goes by its own defaults
 *
 * They are one file of the media, `system/settings.json`, which installed apps read through the
 * media protocol as they read the rest of it: when they first start, and again only when they
 * start as another version of the app (ADR-117 of the app). A change is a publication like any
 * other (`media/writing.ts`): kept in the history, recorded, and the cache emptied of it. The
 * media is public to whoever reads the library, so the file holds nothing secret, and no
 * person's address: an agent's `env` is shown to everyone who reads it.
 */
import { CONTENT_LANGUAGES } from '@slidr/model';
import { z } from 'zod';
import { audit } from './audit.ts';
import type { Context } from './context.ts';
import { json, jsonBody, problem } from './http.ts';
import { forgetLibrary } from './uploads/library.ts';
import { authorize, recordOf, type Actor } from './uploads/access.ts';
import { Lease, NotNow } from './media/lease.ts';
import { readBytes, readManifest, toBytes, toText } from './media/live.ts';
import { recordPublication, undo } from './media/publish.ts';
import { Writing } from './media/writing.ts';

export const SYSTEM_SETTINGS = 'system/settings.json';

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
const OWN_ENV = new Set(['SLIDR_PROTOCOL', 'SLIDR_MCP_TOKEN']);

/**
 * The program an agent runs: a native executable, by its absolute path (`%NAME%` of the
 * environment may begin it, as `%LOCALAPPDATA%\Acme\acme.exe`), or by its name, found where the
 * app finds the CLIs it installs. Not a `.cmd`, `.bat` or `.ps1`: the app stops a turn by ending
 * this one process, and a shim would leave the real CLI running.
 */
const command = z
  .string()
  .trim()
  .min(1)
  .max(260)
  .refine(
    (value) =>
      /^[A-Za-z]:\\|^%[A-Za-z_][A-Za-z0-9_]*%[\\/]|^\//.test(value) ||
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    'A command is an absolute path, or the name of a program.',
  )
  .refine(
    (value) => !/\.(cmd|bat|ps1|vbs|js)$/i.test(value),
    'A command is a native executable: a script is run by its interpreter, named here, with the script in args.',
  );

/** How the app installs the agent's CLI once the user approves: WinGet's package, or npm's. */
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
]);

/** An agent of the organization's own: a CLI of the custom agent protocol. */
export const CustomAgent = z.object({
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
      'SLIDR_PROTOCOL and SLIDR_MCP_TOKEN are the app’s to set.',
    )
    .default({}),
  install: install.optional(),
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

/**
 * Writes the settings into the media, or takes them away (`text` none), as one publication.
 * What it published, or why it could not.
 */
async function publish(ctx: Context, actor: Actor, text: string | undefined) {
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
    try {
      if (text === undefined) await writing.remove(SYSTEM_SETTINGS);
      else await writing.put(SYSTEM_SETTINGS, toBytes(text));
      if (!writing.written) return undefined;
      await writing.finish();
    } catch (error) {
      await undo(writing);
      if (error instanceof NotNow) return problem(409, error.code, error.message);
      throw error;
    }
    const { published, added, changed, removed } = writing;
    forgetLibrary();
    const cache = ctx.purge ? await ctx.purge([SYSTEM_SETTINGS]) : undefined;
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
    ...given,
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
  const published = await publish(ctx, actor, encodeSystemSettings(parsed.data));
  if (published instanceof Response) return published;
  await audit(ctx.state, {
    by: actor.id,
    action: 'settings.system',
    detail: { custom: parsed.data.agents.custom.map((agent) => agent.id) },
  });
  return json({ settings: parsed.data, ...(published ? { published } : {}) });
};

const remove: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'settings');
  if (actor instanceof Response) return actor;
  const published = await publish(ctx, actor, undefined);
  if (published instanceof Response) return published;
  await audit(ctx.state, { by: actor.id, action: 'settings.system.remove' });
  return new Response(null, { status: 204 });
};

export const SYSTEM_ROUTES: [RegExp, Partial<Record<string, Route>>] = [
  /^\/api\/settings\/system$/,
  { GET: read, PUT: save, DELETE: remove },
];
