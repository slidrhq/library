/**
 * The provider people sign in through (docs/SPEC.md §6.2), by OpenID Connect: Google, whose
 * endpoints are known; Microsoft's Entra ID, or any other issuer, whose endpoints its discovery
 * document names (kept for an hour). The library's settings name it (`signIn` of `config.ts`) and
 * the vault keeps its client's secret (`oidc`); on Cloudflare, before the library kept its own
 * settings, the Worker's Google client stands for it (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
 *
 * The ID token comes straight from the provider's token endpoint, over TLS, so its signature needs
 * no check (OpenID Connect Core 3.1.3.7, 6); its issuer, audience, expiry and nonce do, and so
 * does the address: one the provider vouches for, in a domain the library allows.
 */
import { audit } from './audit.ts';
import { readConfig, writeConfig, type SignInSettings } from './config.ts';
import type { Context } from './context.ts';
import { emailOf, isEmail } from './people.ts';

export interface Provider {
  kind: SignInSettings['provider'];
  /** The name on the button. */
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The domains whose addresses may sign in; none, any. */
  allowedDomains: string[];
}

export interface Endpoints {
  /** The issuer its tokens name; Microsoft's common tenants name it with `{tenantid}`. */
  issuer: string;
  authorization: string;
  token: string;
}

/** Someone the provider vouches for. */
export interface Account {
  /** The provider's id of the account, which never changes. */
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE: Endpoints = {
  issuer: GOOGLE_ISSUER,
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
};
/** Google's tokens name their issuer either way. */
const GOOGLE_ISSUERS = [GOOGLE_ISSUER, 'accounts.google.com'];

/** Microsoft's issuer for a tenant: its id, or `organizations`, `common`. */
export const microsoftIssuer = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0`;

const NAMES: Record<Provider['kind'], string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  oidc: 'OpenID Connect',
};

/** How far the clocks of the provider and of this server may differ. */
const SKEW_SECONDS = 60;
const DISCOVERY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** The provider people sign in through, when the library has one, with its secret. */
export async function providerOf(ctx: Context): Promise<Provider | undefined> {
  const settings = ctx.state ? (await readConfig(ctx.state))?.signIn : undefined;
  const secret = settings && ctx.vault ? await ctx.vault.get('oidc') : undefined;
  if (settings && secret) {
    const issuer =
      settings.provider === 'google'
        ? GOOGLE_ISSUER
        : (settings.issuer ?? microsoftIssuer('common'));
    return {
      kind: settings.provider,
      name: settings.name ?? NAMES[settings.provider],
      issuer,
      clientId: settings.clientId,
      clientSecret: secret,
      allowedDomains: settings.allowedDomains,
    };
  }
  const { googleClientId, googleClientSecret } = ctx.auth;
  if (googleClientId && googleClientSecret) {
    return {
      kind: 'google',
      name: NAMES.google,
      issuer: GOOGLE_ISSUER,
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      allowedDomains: [],
    };
  }
  return undefined;
}

/**
 * Names the provider people sign in through, and keeps its client's secret in the vault; none
 * stops signing in through one (the owner's link of a library on a machine still works). A
 * provider is reached first, so one that cannot be is not kept.
 */
export async function saveSignIn(
  ctx: Context,
  settings: SignInSettings | undefined,
  secret: string | undefined,
  by: string,
): Promise<void> {
  if (!ctx.state || !ctx.vault) throw new Error('The library keeps no settings here.');
  const config = await readConfig(ctx.state);
  if (!config) throw new Error('The library is not installed.');
  if (settings) {
    if (!secret) throw new Error('The provider’s client comes with its secret.');
    const issuer =
      settings.provider === 'google'
        ? GOOGLE_ISSUER
        : (settings.issuer ?? microsoftIssuer('common'));
    // Reached once, so a provider that cannot be is said now, not when someone signs in.
    forgetDiscovery();
    await endpointsOf({
      kind: settings.provider,
      name: settings.name ?? NAMES[settings.provider],
      issuer,
      clientId: settings.clientId,
      clientSecret: secret,
      allowedDomains: settings.allowedDomains,
    });
    await ctx.vault.set('oidc', secret, by);
    await writeConfig(ctx.state, { ...config, signIn: settings });
  } else {
    const { signIn: _gone, ...rest } = config;
    await writeConfig(ctx.state, rest);
    await ctx.vault.remove('oidc');
  }
  await audit(ctx.state, {
    by,
    action: settings ? 'sign-in.set' : 'sign-in.removed',
    ...(settings ? { detail: { provider: settings.provider, clientId: settings.clientId } } : {}),
  });
}

/** A provider that cannot be reached, or does not say where its endpoints are. */
export class ProviderUnreachable extends Error {}

const discovered = new Map<string, { until: number; value: Promise<Endpoints> }>();

/** Where a provider's endpoints are: Google's are known; any other's, its discovery document. */
export function endpointsOf(provider: Provider): Promise<Endpoints> {
  if (provider.kind === 'google') return Promise.resolve(GOOGLE);
  const held = discovered.get(provider.issuer);
  if (held && held.until > Date.now()) return held.value;
  const value = (async () => {
    const url = `${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    let document: Record<string, unknown>;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`it answered ${response.status}`);
      document = (await response.json()) as Record<string, unknown>;
    } catch (cause) {
      throw new ProviderUnreachable(`${url} could not be read: ${String(cause)}`);
    }
    const { issuer, authorization_endpoint: authorization, token_endpoint: token } = document;
    if (
      typeof issuer !== 'string' ||
      typeof authorization !== 'string' ||
      typeof token !== 'string'
    ) {
      throw new ProviderUnreachable(`${url} does not name the provider's endpoints.`);
    }
    return { issuer, authorization, token };
  })();
  discovered.set(provider.issuer, { until: Date.now() + DISCOVERY_MS, value });
  value.catch(() => discovered.delete(provider.issuer));
  return value;
}

/** Forgets what discovery found: the tests stand in for providers of their own. */
export function forgetDiscovery() {
  discovered.clear();
}

interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  tid?: string;
  email?: string;
  email_verified?: boolean | string;
  preferred_username?: string;
  name?: string;
  picture?: string;
}

function fromBase64url(text: string) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Whether the token's issuer is the provider's (Microsoft's common tenants by `{tenantid}`). */
function issuedBy(claims: Claims, provider: Provider, endpoints: Endpoints) {
  if (provider.kind === 'google') return GOOGLE_ISSUERS.includes(claims.iss ?? '');
  const expected = claims.tid
    ? endpoints.issuer.replace('{tenantid}', claims.tid)
    : endpoints.issuer;
  return claims.iss === expected;
}

/** The domain of an address is one the library allows, when it allows only some. */
export const domainAllowed = (email: string, allowed: readonly string[]) =>
  allowed.length === 0 || allowed.includes(email.slice(email.lastIndexOf('@') + 1));

/**
 * The account of the ID token the provider answered the code with; none when the token does not
 * hold, or names an address the library does not take.
 */
export function accountOf(
  idToken: string | undefined,
  provider: Provider,
  endpoints: Endpoints,
  nonce: string,
  now = Math.floor(Date.now() / 1000),
): Account | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Claims;
  } catch {
    return undefined;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!issuedBy(claims, provider, endpoints) || !audience.includes(provider.clientId)) {
    return undefined;
  }
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) return undefined;
  if (claims.nonce !== nonce || !claims.sub) return undefined;
  const named =
    claims.email ?? (provider.kind === 'microsoft' ? claims.preferred_username : undefined);
  if (!named || !isEmail(named)) return undefined;
  const email = emailOf(named);
  // Entra ID does not say whether an address is verified: its tenant vouches for it, when the
  // library takes only the tenant's domains (docs/SPEC.md §15).
  const verified =
    claims.email_verified === true ||
    claims.email_verified === 'true' ||
    (provider.kind === 'microsoft' && provider.allowedDomains.length > 0);
  if (!verified || !domainAllowed(email, provider.allowedDomains)) return undefined;
  return {
    sub: claims.sub,
    email,
    name: claims.name || email,
    ...(claims.picture ? { picture: claims.picture } : {}),
  };
}
