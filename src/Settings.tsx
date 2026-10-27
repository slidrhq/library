/**
 * The library's settings, for its admins (docs/SPEC.md §5.3): the address it is reached at and
 * where its media is, which are its host's and only shown; the address installed apps read it at,
 * and the seed of an empty one; how people sign in; and the limits of uploading. Each part is
 * saved on its own, and what can be tried is tried before it is kept: the media is written to, a
 * provider's discovery document read. A secret is written, never shown again.
 */
import { MEDIA_LIBRARY_URL as PUBLISHED } from '@slidr/media-library';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey, type Translate } from './i18n';
import { size } from './media';
import { useRead } from './shared';
import {
  settingsApi,
  tenantOf,
  type Imported,
  type Limits,
  type Provider,
  type Settings as Values,
} from './settingsApi';
import { readAccess, when } from './uploadsApi';

/** What came of a part's work, said in the language shown, whichever that is by then. */
type Note = { ok: boolean; say: (t: Translate, lang: string) => string };

const SAVED: Note = { ok: true, say: (t) => t('settings.saved') };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A part's work: whether it runs, and what came of it. */
function useWork() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const run = (work: () => Promise<Note | undefined>) => {
    setBusy(true);
    setNote(undefined);
    work()
      .then(setNote, (error: unknown) =>
        setNote({ ok: false, say: (t) => t('people.failed', { error: messageOf(error) }) }),
      )
      .finally(() => setBusy(false));
  };
  return { busy, note, run };
}

function Said({ note }: { note?: Note }) {
  const t = useT();
  const [uiLang] = useLang();
  if (!note) return null;
  return (
    <p className={note.ok ? 'ok small' : 'error-text small'} role="status">
      {isolate(note.say(t, uiLang))}
    </p>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Text to be copied whole, and a button that copies it. */
function Copyable({ text, block }: { text: string; block?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <div className={block ? 'copyable block' : 'copyable'}>
      <code className="token-value" dir="ltr">
        {text}
      </code>
      <button type="button" className="small" onClick={copy}>
        {copied ? t('settings.copied') : t('settings.copy')}
      </button>
    </div>
  );
}

/** The address the library is reached at: its host's, shown and never changed here. */
function LibraryPart({ values }: { values: Values }) {
  const t = useT();
  return (
    <section className="settings-part">
      <h3>{t('settings.library.title')}</h3>
      <p className="small">
        {t(values.media.kind === 'folder' ? 'settings.library.script' : 'settings.library.host')}
      </p>
      <code className="token-value" dir="ltr">
        {values.library.url}
      </code>
    </section>
  );
}

const KINDS: Record<Values['media']['kind'], MessageKey> = {
  folder: 'settings.media.kind.folder',
  // The Worker's own bucket, on Cloudflare.
  r2: 'settings.media.kind.r2',
  none: 'settings.media.kind.none',
};

/** Whether installed apps may read an address: HTTPS, or plain HTTP on this machine alone. */
function readable(address: string) {
  const { protocol, hostname } = new URL(address);
  return (
    protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase())
  );
}

/**
 * Where the media is, which is the host's (docs/SPEC.md D13): the folder a local library was
 * installed with, and the room left on its disk; or the Worker's bucket. It is tested here, and
 * the address installed apps read is given.
 */
function MediaPart({ values }: { values: Values }) {
  const t = useT();
  const work = useWork();
  const { media } = values;

  const test = () =>
    work.run(async () => {
      const tried = await settingsApi.test();
      return {
        ok: tried.wrote,
        say: (t, lang) =>
          !tried.wrote
            ? t('settings.media.unreachable', { error: tried.message ?? '' })
            : tried.library
              ? t('settings.media.reachedLibrary', {
                  when: when(lang, tried.library.published),
                  files: t('library.fileMany', { count: tried.library.files }),
                })
              : t('settings.media.reachedEmpty'),
      };
    });

  const address = media.address;
  const policy = [
    "New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Slidr' -Force | Out-Null",
    "New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Slidr' -Name MediaLibraryUrl `",
    `  -PropertyType String -Value '${address}' -Force`,
  ].join('\n');
  // The released installer, under its own name (docs/media-library.md in the app).
  const installer = `Slidr_<version>_x64-setup.exe /S /MEDIA="${address}"`;

  return (
    <section className="settings-part">
      <h3>{t('settings.media.title')}</h3>
      <p className="small">{t('settings.media.explain')}</p>
      <p className="settings-kind">{t(KINDS[media.kind])}</p>
      {media.path && (
        <div className="field">
          <span className="field-label">{t('settings.media.path')}</span>
          <code className="token-value" dir="ltr">
            {media.path}
          </code>
          <span className="hint">
            {media.room &&
              `${t('settings.media.room', { free: size(media.room.free), size: size(media.room.size) })} `}
            {t('settings.media.fixed')}
          </span>
        </div>
      )}
      {media.kind !== 'none' && (
        <div className="row">
          <button type="button" disabled={work.busy} onClick={test}>
            {work.busy ? t('settings.media.testing') : t('settings.media.test')}
          </button>
        </div>
      )}
      <Said note={work.note} />

      <div className="settings-address">
        <h4>{t('settings.media.address')}</h4>
        <Copyable text={address} />
        {!readable(address) && <p className="warn small">{t('settings.media.notHttps')}</p>}
        <details>
          <summary className="small">{t('settings.media.addressHint')}</summary>
          <p className="small">{t('settings.media.policy')}</p>
          <Copyable text={policy} block />
          <p className="small">{t('settings.media.installer')}</p>
          <Copyable text={installer} block />
        </details>
      </div>
    </section>
  );
}

/** Fills an empty media with a published library, a batch at a time, until it holds all of it. */
function SeedPart() {
  const t = useT();
  const [uiLang] = useLang();
  const [version, setVersion] = useState(0);
  const status = useRead(() => settingsApi.status(), [version]);
  const [from, setFrom] = useState(PUBLISHED);
  const [progress, setProgress] = useState<Imported>();
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string>();
  const stopped = useRef(false);
  useEffect(
    () => () => {
      stopped.current = true;
    },
    [],
  );

  const seed = async (event: FormEvent) => {
    event.preventDefault();
    stopped.current = false;
    setRunning(true);
    setFailed(undefined);
    try {
      for (;;) {
        const batch = await settingsApi.seed(from.trim());
        setProgress(batch);
        if (batch.done || stopped.current) break;
        // A round that copied nothing will not do better the next time.
        if (batch.copied === 0 && batch.failed.length > 0) {
          setFailed(batch.failed[0]!.message);
          break;
        }
      }
    } catch (error) {
      setFailed(messageOf(error));
    } finally {
      setRunning(false);
      setVersion((at) => at + 1);
    }
  };

  const live = status.value?.live;
  if (live === undefined) return null;
  return (
    <form className="settings-part" onSubmit={(event) => void seed(event)}>
      <h3>{t('settings.seed.title')}</h3>
      {live && !running ? (
        <p className="small">
          {progress?.done
            ? t('settings.seed.done')
            : t('settings.seed.live', {
                when: when(uiLang, status.value?.published ?? ''),
                files: t('library.fileMany', { count: status.value?.files ?? 0 }),
              })}
        </p>
      ) : (
        <>
          <p className="small">{t('settings.seed.explain')}</p>
          <div className="row">
            <input
              type="url"
              required
              dir="ltr"
              value={from}
              disabled={running}
              onChange={(event) => setFrom(event.target.value)}
              aria-label={t('settings.seed.from')}
            />
            {running ? (
              <button type="button" onClick={() => (stopped.current = true)}>
                {t('settings.seed.stop')}
              </button>
            ) : (
              <button type="submit" className="primary">
                {t('settings.seed.start')}
              </button>
            )}
          </div>
          {progress && (
            <div className="settings-progress">
              <progress max={progress.files} value={progress.present} />
              <span className="small">
                {t('settings.seed.progress', {
                  present: progress.present.toLocaleString(uiLang),
                  files: progress.files.toLocaleString(uiLang),
                })}
              </span>
              {progress.failed.length > 0 && (
                <span className="warn small">
                  {t('settings.seed.failed', { count: progress.failed.length })}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {failed && <p className="error-text small">{t('people.failed', { error: failed })}</p>}
    </form>
  );
}

const PROVIDERS: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Microsoft (Entra ID)',
  oidc: '',
};

function SignInPart({
  values,
  local,
  owner,
  onSaved,
}: {
  values: Values;
  /** Whether the owner signs in by a link of this machine, without a provider. */
  local: boolean;
  /** Whether the one looking is the owner: how people sign in is the owner's alone. */
  owner: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const set = values.signIn && !values.signIn.host ? values.signIn : undefined;
  const [provider, setProvider] = useState<Provider | 'none'>(
    set?.provider ?? (local ? 'none' : 'google'),
  );
  const [clientId, setClientId] = useState(set?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(tenantOf(set?.issuer) ?? '');
  const [issuer, setIssuer] = useState(set?.provider === 'oidc' ? (set.issuer ?? '') : '');
  const [name, setName] = useState(set?.name ?? '');
  const [domains, setDomains] = useState(set?.allowedDomains.join(', ') ?? '');
  const work = useWork();
  const redirect = new URL('/auth/callback', values.library.url).href;
  // The secret kept is that of the provider saved; another provider comes with its own.
  const kept = set?.secret?.set && set.provider === provider ? set.secret : undefined;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (provider === 'none') {
      if (set && !confirm(t('settings.signIn.removeConfirm'))) return;
      work.run(async () => {
        await settingsApi.noSignIn();
        onSaved();
        return SAVED;
      });
      return;
    }
    work.run(async () => {
      await settingsApi.signIn({
        provider,
        clientId: clientId.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(provider === 'microsoft' ? { tenant: tenant.trim() } : {}),
        ...(provider === 'oidc' ? { issuer: issuer.trim(), name: name.trim() } : {}),
        allowedDomains: domains.split(/[\s,]+/).filter(Boolean),
      });
      setSecret('');
      onSaved();
      return SAVED;
    });
  };

  if (!values.editable.signIn || !owner) {
    return (
      <section className="settings-part">
        <h3>{t('settings.signIn.title')}</h3>
        <p className="small">
          {!values.editable.signIn
            ? t(values.signIn?.host ? 'settings.signIn.host' : 'settings.signIn.hostNone')
            : t('settings.signIn.ownerOnly')}
        </p>
        {values.editable.signIn && values.signIn && (
          <p className="settings-kind">
            {values.signIn.provider === 'oidc'
              ? (values.signIn.name ?? t('settings.signIn.oidc'))
              : PROVIDERS[values.signIn.provider]}
          </p>
        )}
        {values.signIn && (
          <Field label={t('settings.signIn.redirect')}>
            <Copyable text={redirect} />
          </Field>
        )}
      </section>
    );
  }

  return (
    <form className="settings-part" onSubmit={save}>
      <h3>{t('settings.signIn.title')}</h3>
      <p className="small">
        {t('settings.signIn.explain')} {local && isolate(t('settings.signIn.local'))}
      </p>
      <Field label={t('settings.signIn.provider')}>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value as Provider | 'none')}
        >
          {local && <option value="none">{t('settings.signIn.none')}</option>}
          <option value="google">{PROVIDERS.google}</option>
          <option value="microsoft">{PROVIDERS.microsoft}</option>
          <option value="oidc">{t('settings.signIn.oidc')}</option>
        </select>
      </Field>
      {provider !== 'none' && (
        <>
          {provider === 'microsoft' && (
            <Field label={t('settings.signIn.tenant')} hint={t('settings.signIn.tenantHint')}>
              <input
                required
                dir="ltr"
                placeholder="contoso.onmicrosoft.com"
                pattern="(?!(organizations|common|consumers)$)[A-Za-z0-9.\-]+"
                value={tenant}
                onChange={(event) => setTenant(event.target.value)}
              />
            </Field>
          )}
          {provider === 'oidc' && (
            <>
              <Field
                label={t('settings.signIn.issuer')}
                hint={isolate(t('settings.signIn.issuerHint'))}
              >
                <input
                  type="url"
                  required
                  dir="ltr"
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://sso.example.org/realms/staff"
                />
              </Field>
              <Field label={t('settings.signIn.name')}>
                <input
                  required
                  maxLength={60}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </>
          )}
          <Field label={t('settings.signIn.clientId')}>
            <input
              required
              dir="ltr"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field
            label={t('settings.signIn.secret')}
            hint={
              kept?.at
                ? t('settings.signIn.secretKept', { when: when(uiLang, kept.at) })
                : undefined
            }
          >
            <input
              type="password"
              required={!kept}
              dir="ltr"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={kept ? '••••••••' : ''}
            />
          </Field>
          <Field
            label={t('settings.signIn.domains')}
            hint={t(
              provider === 'microsoft'
                ? 'settings.signIn.domainsMicrosoft'
                : 'settings.signIn.domainsHint',
            )}
          >
            <input
              required={provider === 'microsoft'}
              dir="ltr"
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              placeholder="example.org, example.co.il"
            />
          </Field>
          <Field label={t('settings.signIn.redirect')}>
            <Copyable text={redirect} />
          </Field>
        </>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={work.busy}>
          {provider === 'none' && set ? t('settings.signIn.remove') : t('settings.save')}
        </button>
      </div>
      <Said note={work.note} />
    </form>
  );
}

const LIMITS: { name: keyof Limits; label: MessageKey; unit: number }[] = [
  { name: 'pending', label: 'settings.limits.pending', unit: 1 },
  { name: 'bytes', label: 'settings.limits.bytes', unit: 1024 * 1024 },
  { name: 'tokens', label: 'settings.limits.tokens', unit: 1 },
  { name: 'writesPerMinute', label: 'settings.limits.writes', unit: 1 },
];

function LimitsPart({ values, onSaved }: { values: Values; onSaved: () => void }) {
  const t = useT();
  const [uiLang] = useLang();
  // A limit at its default is left empty, and stays at the default if it changes.
  const [given, setGiven] = useState<Record<keyof Limits, string>>(
    () =>
      Object.fromEntries(
        LIMITS.map(({ name, unit }) => [
          name,
          values.limits[name] === values.defaults[name] ? '' : String(values.limits[name] / unit),
        ]),
      ) as Record<keyof Limits, string>,
  );
  const work = useWork();
  const save = (event: FormEvent) => {
    event.preventDefault();
    const limits = Object.fromEntries(
      LIMITS.filter(({ name }) => given[name].trim()).map(({ name, unit }) => [
        name,
        Math.round(Number(given[name]) * unit),
      ]),
    );
    work.run(async () => {
      await settingsApi.limits(limits);
      onSaved();
      return SAVED;
    });
  };
  return (
    <form className="settings-part" onSubmit={save}>
      <h3>{t('settings.limits.title')}</h3>
      <p className="small">{t('settings.limits.explain')}</p>
      <div className="settings-limits">
        {LIMITS.map(({ name, label, unit }) => (
          <Field key={name} label={t(label)}>
            <input
              type="number"
              min={1}
              step={1}
              value={given[name]}
              onChange={(event) => setGiven((was) => ({ ...was, [name]: event.target.value }))}
              placeholder={t('settings.limits.default', {
                value: (values.defaults[name] / unit).toLocaleString(uiLang),
              })}
            />
          </Field>
        ))}
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={work.busy}>
          {t('settings.save')}
        </button>
      </div>
      <Said note={work.note} />
    </form>
  );
}

export function Settings() {
  const t = useT();
  const access = useRead(readAccess, []);
  // Read again after each change, the parts kept as they are meanwhile, with what they said.
  const [values, setValues] = useState<Values>();
  const [failed, setFailed] = useState<string>();
  const onSaved = useCallback(() => {
    settingsApi.read().then(setValues, (error: unknown) => setFailed(messageOf(error)));
  }, []);
  useEffect(onSaved, [onSaved]);

  if (access.value && !access.value.user?.can.settings) {
    return (
      <div className="upload-empty">
        <p>{t('settings.closed')}</p>
      </div>
    );
  }
  if (failed !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: failed }))}</p>;
  }
  if (!values || !access.value) return <p className="muted">{t('settings.loading')}</p>;
  return (
    <div className="settings">
      <LibraryPart values={values} />
      <MediaPart values={values} />
      {values.media.kind !== 'none' && <SeedPart key={values.media.path} />}
      <SignInPart
        values={values}
        local={access.value.local}
        owner={Boolean(access.value.user?.can.owner)}
        onSaved={onSaved}
      />
      <LimitsPart values={values} onSaved={onSaved} />
    </div>
  );
}
