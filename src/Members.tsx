/**
 * The library's members (docs/SPEC.md §6, §11): an admin names them by email, a reviewer or an
 * admin, changes a role or takes it away, and blocks a person; the owner hands the library over.
 * Anyone who signs in may upload: the people who did, and have no role, are listed apart.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey } from './i18n';
import { membersApi, type Member } from './membersApi';
import { matches, useRead } from './shared';
import { readAccess, when, type Role } from './uploadsApi';

const ROLE_NAMES: Record<Role | 'none', MessageKey> = {
  owner: 'people.roleName.owner',
  admin: 'people.roleName.admin',
  reviewer: 'people.roleName.reviewer',
  none: 'people.roleName.none',
};

/** A person's first letter, as the account button shows one without a photo. */
function Initial({ person }: { person: Member }) {
  return (
    <span className="avatar member-avatar" aria-hidden>
      {[...(person.name ?? person.email)][0]?.toUpperCase()}
    </span>
  );
}

function Person({
  person,
  me,
  owner,
  busy,
  onRole,
  onBlock,
  onHandOver,
}: {
  person: Member;
  me?: string;
  /** Whether the one looking is the owner, who hands the library over. */
  owner: boolean;
  busy: boolean;
  onRole: (role: 'reviewer' | 'admin' | 'none') => void;
  onBlock: (blocked: boolean) => void;
  onHandOver: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const self = person.email === me;
  return (
    <li className="member">
      <Initial person={person} />
      <div className="member-who">
        <strong>
          {person.name ? isolate(person.name) : <bdi>{person.email}</bdi>}
          {self && <span className="member-self">{t('people.you')}</span>}
        </strong>
        {person.name && (
          <span className="muted small">
            <bdi>{person.email}</bdi>
          </span>
        )}
        <span className="muted small">
          {person.lastSeen
            ? t('people.lastSeen', { when: when(uiLang, person.lastSeen) })
            : t('people.neverSeen')}
        </span>
      </div>
      <div className="member-controls">
        <div className="member-role">
          {person.role === 'owner' ? (
            <span className="status-badge published">{t('people.roleName.owner')}</span>
          ) : person.blocked ? (
            <span className="status-badge rejected">{t('people.blockedBadge')}</span>
          ) : (
            <select
              value={person.role ?? 'none'}
              disabled={busy}
              aria-label={t('people.add.role')}
              onChange={(event) => onRole(event.target.value as 'reviewer' | 'admin' | 'none')}
            >
              {(['none', 'reviewer', 'admin'] as const).map((role) => (
                <option key={role} value={role}>
                  {t(ROLE_NAMES[role])}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="member-actions">
          {owner && (person.role === 'admin' || person.role === 'reviewer') && (
            <button type="button" className="ghost small" disabled={busy} onClick={onHandOver}>
              {t('people.handOver')}
            </button>
          )}
          {person.role !== 'owner' && !self && (
            <button
              type="button"
              className={person.blocked ? 'ghost small' : 'ghost small danger'}
              disabled={busy}
              onClick={() => onBlock(!person.blocked)}
            >
              {t(person.blocked ? 'people.unblock' : 'people.block')}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function Members({ query }: { query: string }) {
  const t = useT();
  const access = useRead(readAccess, []);
  const [version, setVersion] = useState(0);
  const list = useRead(() => membersApi.list(), [version]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'reviewer' | 'admin'>('reviewer');

  /** Does a change, then reads the members again; says what went wrong, if anything did. */
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

  const people = useMemo(
    () => (list.value?.people ?? []).filter((one) => matches(query, one.email, one.name)),
    [list.value, query],
  );
  const members = people.filter((one) => one.role || one.blocked);
  const others = people.filter((one) => !one.role && !one.blocked);
  const me = access.value?.user?.email;
  const owner = access.value?.user?.can.owner ?? false;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    change(() => membersApi.name(address, role).then(() => setEmail('')));
  };

  const row = (person: Member) => (
    <Person
      key={person.email}
      person={person}
      me={me}
      owner={owner}
      busy={busy}
      onRole={(next) =>
        change(() =>
          next === 'none' ? membersApi.remove(person.email) : membersApi.name(person.email, next),
        )
      }
      onBlock={(blocked) => {
        if (blocked && !confirm(t('people.blockConfirm', { email: person.email }))) return;
        change(() => membersApi.block(person.email, blocked));
      }}
      onHandOver={() => {
        if (!confirm(t('people.handOverConfirm', { email: person.email }))) return;
        change(() => membersApi.handOver(person.email));
      }}
    />
  );

  if (access.value && !access.value.mayManage) {
    return (
      <div className="upload-empty">
        <p>{t('people.closed')}</p>
      </div>
    );
  }

  return (
    <div className="members">
      <form className="member-add" onSubmit={add}>
        <h3>{t('people.add.title')}</h3>
        <div className="row">
          <input
            type="email"
            required
            dir="ltr"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="someone@example.org"
            aria-label={t('people.add.email')}
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as 'reviewer' | 'admin')}
            aria-label={t('people.add.role')}
          >
            <option value="reviewer">{t('people.roleName.reviewer')}</option>
            <option value="admin">{t('people.roleName.admin')}</option>
          </select>
          <button type="submit" className="primary" disabled={busy}>
            {t('people.add.submit')}
          </button>
        </div>
        {access.value && !access.value.provider && (
          <p className="hint">{isolate(t('people.noProvider'))}</p>
        )}
      </form>
      {failed && <p className="error-text">{isolate(failed)}</p>}
      {list.error !== undefined && (
        <p className="error-text">{isolate(t('people.failed', { error: list.error }))}</p>
      )}
      {!list.value && list.error === undefined && <p className="muted">{t('people.loading')}</p>}
      {members.length > 0 && (
        <section>
          <h3>{t('people.members')}</h3>
          <ul className="member-list">{members.map(row)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h3>{t('people.others')}</h3>
          <ul className="member-list">{others.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
