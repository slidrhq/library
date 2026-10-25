/**
 * The profile of the one signed in (docs/SPEC.md §7, §11): the account, how it signed in and what
 * it may do, and its tokens: made here, shown once, revoked here. A token is all a program sends
 * to upload as the account (`Authorization: Bearer slk_…`).
 */
import { useState, type FormEvent } from 'react';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey } from './i18n';
import { useRead } from './shared';
import { tokensApi, type Days, type Scope, type Token } from './tokensApi';
import { readAccess, when, type Access } from './uploadsApi';

const DAYS: Days[] = [30, 90, 365, null];

function daysLabel(t: ReturnType<typeof useT>, days: Days) {
  if (days === null) return t('tokens.never');
  return days === 365 ? t('tokens.year') : t('tokens.days', { count: days });
}

/** What the account's role lets it do, in words, as its menu says it. */
function roleOf(user: NonNullable<Access['user']>): MessageKey {
  if (user.blocked) return 'people.role.blocked';
  return user.role ? `people.role.${user.role}` : 'people.role.uploader';
}

/** A token just made: shown once, with a way to copy it and to try it. */
function Made({ token, onDone }: { token: string; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(token).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <div className="token-made" role="status">
      <p className="warn small">{t('tokens.made')}</p>
      <div className="row">
        <code className="token-value" dir="ltr">
          {token}
        </code>
        <button type="button" onClick={copy}>
          {copied ? t('tokens.copied') : t('tokens.copy')}
        </button>
      </div>
      <p className="small">{t('tokens.example')}</p>
      <code className="token-example" dir="ltr">
        {`curl.exe -H "Authorization: Bearer ${token}" ${location.origin}/api/uploads`}
      </code>
      <button type="button" className="ghost small" onClick={onDone}>
        {t('tokens.done')}
      </button>
    </div>
  );
}

/** A moment, with its year when it is not this one: a token holds for up to a year. */
function dated(lang: string, at: string) {
  const moment = new Date(at);
  if (moment.getFullYear() === new Date().getFullYear()) return when(lang, at);
  return moment.toLocaleString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
}

function TokenRow({ token, onRevoke }: { token: Token; onRevoke: () => void }) {
  const t = useT();
  const [uiLang] = useLang();
  return (
    <li className="token">
      <div className="token-who">
        <strong>{isolate(token.name)}</strong>
        <span className="muted small">
          <code dir="ltr">slk_{token.hint}…</code>
          {' · '}
          {t(token.scope === 'publish' ? 'tokens.scope.publish' : 'tokens.scope.upload')}
        </span>
        <span className="muted small">
          {t('tokens.created', { when: when(uiLang, token.created) })}
          {' · '}
          {token.expires
            ? t('tokens.expiresAt', { when: dated(uiLang, token.expires) })
            : t('tokens.noExpiry')}
          {' · '}
          {token.lastUsed
            ? t('tokens.lastUsed', { when: when(uiLang, token.lastUsed) })
            : t('tokens.unused')}
        </span>
      </div>
      <button type="button" className="ghost small danger" onClick={onRevoke}>
        {t('tokens.revoke')}
      </button>
    </li>
  );
}

export function Profile() {
  const t = useT();
  const access = useRead(readAccess, []);
  const [version, setVersion] = useState(0);
  const list = useRead(() => tokensApi.list(), [version]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('upload');
  const [days, setDays] = useState<Days>(90);
  const [made, setMade] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const user = access.value?.user;
  if (access.value && !user) {
    return (
      <div className="upload-empty">
        <p>{t('tokens.signIn')}</p>
      </div>
    );
  }

  const change = (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(undefined);
    work()
      .then(
        () => setVersion((at) => at + 1),
        (error: unknown) =>
          setFailed(
            t('people.failed', { error: error instanceof Error ? error.message : String(error) }),
          ),
      )
      .finally(() => setBusy(false));
  };

  const make = (event: FormEvent) => {
    event.preventDefault();
    const named = name.trim();
    if (!named) return;
    change(() =>
      tokensApi.make(named, scope, days).then((token) => {
        setMade(token.token);
        setName('');
      }),
    );
  };

  const header = 'Authorization: Bearer slk_…';
  return (
    <div className="profile">
      {user && (
        <section className="profile-who">
          <div>
            <strong>{isolate(user.name)}</strong>
            {user.name !== user.email && (
              <span className="muted small">
                <bdi>{user.email}</bdi>
              </span>
            )}
            <span className="muted small">
              {user.provider === 'local'
                ? t('tokens.providerLocal')
                : t('tokens.provider', {
                    provider: access.value?.provider?.name ?? user.provider,
                  })}
            </span>
          </div>
          <p className={user.role ? 'account-role editor' : 'account-role'}>{t(roleOf(user))}</p>
        </section>
      )}

      <section>
        <h3>{t('tokens.title')}</h3>
        <p className="small">
          {t('tokens.explain')}{' '}
          <code dir="ltr" className="token-header">
            {header}
          </code>
        </p>
      </section>

      {made ? (
        <Made token={made} onDone={() => setMade(undefined)} />
      ) : (
        user?.can.upload && (
          <form className="member-add" onSubmit={make}>
            <h3>{t('tokens.new')}</h3>
            <div className="row">
              <input
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('tokens.namePlaceholder')}
                aria-label={t('tokens.name')}
              />
              {user.can.members && (
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as Scope)}
                  aria-label={t('tokens.scope')}
                >
                  <option value="upload">{t('tokens.scope.upload')}</option>
                  <option value="publish">{t('tokens.scope.publish')}</option>
                </select>
              )}
              <select
                value={String(days)}
                onChange={(event) =>
                  setDays(
                    event.target.value === 'null' ? null : (Number(event.target.value) as Days),
                  )
                }
                aria-label={t('tokens.expires')}
              >
                {DAYS.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {daysLabel(t, option)}
                  </option>
                ))}
              </select>
              <button type="submit" className="primary" disabled={busy}>
                {t('tokens.make')}
              </button>
            </div>
          </form>
        )
      )}

      {failed && <p className="error-text">{isolate(failed)}</p>}
      {list.error !== undefined && (
        <p className="error-text">{isolate(t('people.failed', { error: list.error }))}</p>
      )}
      {list.value && list.value.tokens.length === 0 && <p className="muted">{t('tokens.none')}</p>}
      {list.value && list.value.tokens.length > 0 && (
        <ul className="member-list">
          {list.value.tokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              onRevoke={() => {
                if (!confirm(t('tokens.revokeConfirm', { name: token.name }))) return;
                change(() => tokensApi.revoke(token.id));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
