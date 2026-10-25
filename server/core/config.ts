/**
 * The library's settings that are not secret (docs/SPEC.md §5.3), kept in its state store as
 * `config/library.json`: the address it is reached at, and where its media is. Its keys are in
 * the vault (`vault.ts`), never here.
 */
import { z } from 'zod';
import type { Bucket } from './bucket.ts';

export const CONFIG = 'config/library.json';

const address = z.url({ protocol: /^https?$/ });

/** A folder on the machine the library runs on (docs/SPEC.md §4.5). */
const FolderMedia = z.object({
  kind: z.literal('folder'),
  /** Its absolute path. */
  path: z.string().min(1),
  /** Where installed apps read it, when another server publishes the folder. */
  publicUrl: address.optional(),
});

/** A server name, as a store is reached at: a host name, or an address. */
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/);
/** A folder on a server, from its root: `/var/www/media`. */
const remoteFolder = z
  .string()
  .regex(/^\/[^\0]*$/)
  .refine((path) => !path.split('/').includes('..'), 'A folder does not climb out of another.');

/**
 * A folder on a server reached over SSH (docs/SPEC.md §4.5). Its key is the vault's `media`: a
 * private key with its passphrase, or a password. The server is known by its host key, pinned by
 * its fingerprint once an admin confirmed it.
 */
const SftpMedia = z.object({
  kind: z.literal('sftp'),
  host,
  port: z.int().min(1).max(65535).default(22),
  user: z.string().min(1).max(100),
  root: remoteFolder,
  /** `SHA256:` and the host key's hash, as `ssh-keygen -l` shows it. */
  hostKey: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
    .optional(),
  publicUrl: address.optional(),
});

/**
 * A folder on an FTP server: over TLS, asked for (`explicit`) or from the start (`implicit`); in
 * clear only when an admin allowed it, since the password then travels unencrypted. Its password
 * is the vault's `media`.
 */
const FtpMedia = z
  .object({
    kind: z.literal('ftp'),
    host,
    port: z.int().min(1).max(65535).optional(),
    user: z.string().min(1).max(100),
    root: remoteFolder,
    tls: z.enum(['explicit', 'implicit', 'none']).default('explicit'),
    allowUnencrypted: z.boolean().optional(),
    publicUrl: address.optional(),
  })
  .refine((ftp) => ftp.tls !== 'none' || ftp.allowUnencrypted === true, {
    message: 'Unencrypted FTP sends the password in clear: allow it first.',
    path: ['tls'],
  });

/**
 * A Cloudflare R2 bucket reached from a machine, through its S3 API (`media/r2s3.ts`), and served
 * at its own domain, where installed apps read it. Its key is the vault's `media`: an R2 API
 * token's S3 credentials, and the token that empties the cache of the domain's zone.
 */
const R2Media = z.object({
  kind: z.literal('r2'),
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  /** The bucket's own domain: `https://media.example.org/`. */
  publicUrl: address,
  /** The zone of that domain, whose cache a publication empties of what it wrote. */
  zoneId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});

/** Where the published library is kept. */
export const MediaSettings = z.discriminatedUnion('kind', [
  FolderMedia,
  SftpMedia,
  FtpMedia,
  R2Media,
]);
export type MediaSettings = z.infer<typeof MediaSettings>;

/**
 * Signing in through an OpenID Connect provider (docs/SPEC.md §6.2): Google, Microsoft's Entra
 * ID, or any issuer. The client's secret is the vault's `oidc`.
 */
export const SignInSettings = z.object({
  provider: z.enum(['google', 'microsoft', 'oidc']),
  /** The issuer: for Microsoft, its tenant's; for another provider, its own. */
  issuer: address.optional(),
  clientId: z.string().min(1),
  /** The name on the button, for another provider. */
  name: z.string().min(1).max(60).optional(),
  /** The domains whose addresses may sign in; none, any. */
  allowedDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
});
export type SignInSettings = z.infer<typeof SignInSettings>;

export const LibraryConfig = z.object({
  version: z.literal(1),
  /** When the library was installed. */
  installed: z.string(),
  /**
   * The address it is reached at, as its people's browsers name it. Without it, each request's
   * own, which only a library on this machine goes by.
   */
  url: address.optional(),
  media: MediaSettings.optional(),
  signIn: SignInSettings.optional(),
  /** What one person may keep waiting, and how fast they may write (`limits.ts`). */
  limits: z
    .object({
      pending: z.int().min(1),
      bytes: z.int().min(1),
      tokens: z.int().min(1),
      writesPerMinute: z.int().min(1),
    })
    .partial()
    .optional(),
});
export type LibraryConfig = z.infer<typeof LibraryConfig>;

/** The settings in the store; none before the library is installed. */
export async function readConfig(store: Bucket): Promise<LibraryConfig | undefined> {
  const object = await store.get(CONFIG);
  if (!object) return undefined;
  const parsed = LibraryConfig.safeParse(JSON.parse(await object.text()));
  if (!parsed.success) throw new Error(`${CONFIG} is not the library's settings: ${parsed.error}`);
  return parsed.data;
}

export async function writeConfig(store: Bucket, config: LibraryConfig): Promise<void> {
  await store.put(CONFIG, `${JSON.stringify(LibraryConfig.parse(config), null, 2)}\n`, {
    httpMetadata: { contentType: 'application/json' },
  });
}
