/**
 * Who is signed in (server/core/auth.ts): through the library's provider, Google or another, or,
 * on the machine a library is installed on, its owner by a link of the CLI. Anyone signed in may
 * upload; what else the account may do is its role's (docs/SPEC.md §6.1). The page asks the
 * server that serves it; where none answers (the page served without it) or no one may sign in
 * there, the page shows no account.
 */
import { useEffect, useRef, useState } from 'react';
import { useT, type MessageKey } from './i18n';
import type { Me } from './uploadsApi';

type Account = NonNullable<Me['user']>;

async function readMe(): Promise<Me | undefined> {
  const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
  const type = response.headers.get('Content-Type') ?? '';
  if (!response.ok || !type.includes('application/json')) return undefined;
  return (await response.json()) as Me;
}

/**
 * Whether the Worker sent the person back without signing them in (`?signin=failed`). It is read
 * once, when the page loads, and taken off the address.
 */
const failedOnArrival = (() => {
  const url = new URL(location.href);
  if (url.searchParams.get('signin') !== 'failed') return false;
  url.searchParams.delete('signin');
  history.replaceState(history.state, '', url);
  return true;
})();

/** Off to the provider, coming back to this very page and item. */
export function signIn() {
  const back = location.pathname + location.search + location.hash;
  location.assign(`/auth/login?${new URLSearchParams({ return: back })}`);
}

/** Google's mark, as its sign-in buttons show it. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** The account's photo, or the first letter of its name. */
function Avatar({ user, size }: { user: Account; size: number }) {
  const [broken, setBroken] = useState(false);
  if (user.picture && !broken) {
    return (
      <img
        className="avatar"
        src={user.picture}
        alt=""
        width={size}
        height={size}
        // Google's photos are refused to a page that sends its address.
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      aria-hidden
    >
      {[...user.name][0]?.toUpperCase()}
    </span>
  );
}

/** What the account's role lets it do, in words. */
function roleOf(user: Account): MessageKey {
  if (user.blocked) return 'people.role.blocked';
  if (user.role) return `people.role.${user.role}`;
  return 'people.role.uploader';
}

/**
 * Signing in, at the end of the top bar: through the provider, and on the library's own machine
 * by the owner's link; once signed in, the account and what it may do.
 */
export function AccountControl() {
  const t = useT();
  const [me, setMe] = useState<Me>();
  const [failed, setFailed] = useState(failedOnArrival);
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    readMe().then(
      (found) => live && setMe(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  // The menu closes on a click outside it, and on Escape; so does the hint of the owner's link.
  useEffect(() => {
    if (!open && !hint) return;
    const close = () => {
      setOpen(false);
      setHint(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, hint]);

  if (!me?.signIn) return null;
  const user = me.user;

  const signOut = async () => {
    setOpen(false);
    const response = await fetch('/auth/logout', { method: 'POST' });
    if (response.ok) setMe({ ...me, user: null });
  };

  if (!user) {
    const provider = me.provider;
    return (
      <div className="account" ref={box}>
        {failed && (
          <p className="account-failed" role="alert">
            {t('account.failed')}
            <button
              type="button"
              className="ghost"
              aria-label={t('account.dismiss')}
              onClick={() => setFailed(false)}
            >
              ×
            </button>
          </p>
        )}
        {me.local && (
          <button
            type="button"
            className={provider ? 'ghost small' : undefined}
            aria-expanded={hint}
            onClick={() => setHint(!hint)}
          >
            {t('people.signInHere')}
          </button>
        )}
        {provider?.kind === 'google' && (
          <button type="button" className="google-sign-in" onClick={signIn}>
            <GoogleMark />
            <span>{t('account.signIn')}</span>
          </button>
        )}
        {provider && provider.kind !== 'google' && (
          <button type="button" className="primary" onClick={signIn}>
            {t('people.signInWith', { name: provider.name })}
          </button>
        )}
        {hint && (
          <div className="account-menu" role="dialog" aria-label={t('people.signInHere')}>
            <p className="small">{t('people.localHint')}</p>
            <code className="account-command" dir="ltr">
              pnpm library login
            </code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="account" ref={box}>
      <button
        type="button"
        className="account-button"
        aria-expanded={open}
        aria-label={t('account.menu', { name: user.name })}
        // The photo alone, as Google's own pages show the account; the name and address on hover.
        title={`${user.name}\n${user.email}`}
        onClick={() => setOpen(!open)}
      >
        <Avatar user={user} size={32} />
      </button>
      {open && (
        <div className="account-menu">
          <div className="account-who">
            <Avatar user={user} size={40} />
            <div>
              <strong>{user.name}</strong>
              {/* The owner signed in by the CLI's link is named by the address alone. */}
              {user.name !== user.email && (
                <span className="account-email">
                  <bdi>{user.email}</bdi>
                </span>
              )}
            </div>
          </div>
          <p
            className={
              user.blocked ? 'account-role' : user.role ? 'account-role editor' : 'account-role'
            }
          >
            {t(roleOf(user))}
          </p>
          <nav className="account-links">
            <a href="#lib=profile" onClick={() => setOpen(false)}>
              {t('tokens.nav')}
            </a>
            {user.can.members && (
              <a href="#lib=members" onClick={() => setOpen(false)}>
                {t('people.nav')}
              </a>
            )}
          </nav>
          <button type="button" onClick={() => void signOut().catch(() => undefined)}>
            {t('account.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
