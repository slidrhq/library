/**
 * The library's settings, for its admins (docs/SPEC.md §5.3): the address it is reached at; its
 * media, the address installed apps read it at, and the seed of an empty one; how people sign in;
 * and the limits of uploading. Each part is saved on its own, and what can be tried is tried before
 * it is kept: a media store is written to, a provider's discovery document read. A secret is
 * written, never shown again.
 */
import { MEDIA_LIBRARY_URL as PUBLISHED } from '@slidr/media-library';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey, type Translate } from './i18n';
import { useRead } from './shared';
import {
  settingsApi,
  tenantOf,
  type HostKeyToConfirm,
  type Imported,
  type Limits,
  type MediaKey,
  type MediaSettings,
  type Provider,
  type Settings as Values,
  type StoreTest,
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

function LibraryPart({ values, onSaved }: { values: Values; onSaved: () => void }) {
  const t = useT();
  const [url, setUrl] = useState(values.library.url);
  const work = useWork();
  const save = (event: FormEvent) => {
    event.preventDefault();
    work.run(async () => {
      await settingsApi.library(url.trim());
      onSaved();
      return SAVED;
    });
  };
  return (
    <form className="settings-part" onSubmit={save}>
      <h3>{t('settings.library.title')}</h3>
      {values.editable.url ? (
        <>
          <p className="small">{t('settings.library.explain')}</p>
          <div className="row">
            <input
              type="url"
              dir="ltr"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://library.example.org/"
              aria-label={t('settings.library.title')}
            />
            <button type="submit" className="primary" disabled={work.busy}>
              {t('settings.save')}
            </button>
          </div>
          <Said note={work.note} />
        </>
      ) : (
        <>
          <p className="small">{t('settings.library.host')}</p>
          <code className="token-value" dir="ltr">
            {values.library.url}
          </code>
        </>
      )}
    </form>
  );
}

const KINDS: Record<Values['media']['kind'], MessageKey> = {
  folder: 'settings.media.kind.folder',
  sftp: 'settings.media.kind.sftp',
  ftp: 'settings.media.kind.ftp',
  // The Worker's own bucket, on Cloudflare; on a machine, a bucket it reaches (`R2_KIND`).
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

type Kind = MediaSettings['kind'];

/** An R2 bucket, as a library on a machine names it among its kinds of store. */
const R2_KIND: MessageKey = 'settings.media.kind.r2s3';

/** The fields of the store as they are being written: text, as the inputs hold it. */
interface Draft {
  kind: Kind;
  path: string;
  host: string;
  port: string;
  user: string;
  root: string;
  tls: NonNullable<MediaSettings['tls']>;
  allowUnencrypted: boolean;
  publicUrl: string;
  auth: 'key' | 'password';
  privateKey: string;
  passphrase: string;
  password: string;
  accountId: string;
  bucket: string;
  zoneId: string;
  accessKeyId: string;
  secretAccessKey: string;
  purgeToken: string;
}

const draftOf = (media: Values['media']): Draft => ({
  kind:
    media.kind === 'sftp' || media.kind === 'ftp' || (media.kind === 'r2' && media.accountId)
      ? media.kind
      : 'folder',
  path: media.path ?? '',
  host: media.host ?? '',
  port: media.port ? String(media.port) : '',
  user: media.user ?? '',
  root: media.root ?? '',
  tls: media.tls ?? 'explicit',
  allowUnencrypted: media.allowUnencrypted ?? false,
  publicUrl: media.publicUrl ?? '',
  auth: 'key',
  privateKey: '',
  passphrase: '',
  password: '',
  accountId: media.accountId ?? '',
  bucket: media.bucket ?? '',
  zoneId: media.zoneId ?? '',
  accessKeyId: '',
  secretAccessKey: '',
  purgeToken: '',
});

/** The settings a draft names, and its key, when one was written. */
function settingsOf(draft: Draft, hostKey?: string): { settings: MediaSettings; key?: MediaKey } {
  const publicUrl = draft.publicUrl.trim();
  const common = publicUrl ? { publicUrl } : {};
  if (draft.kind === 'folder')
    return { settings: { kind: 'folder', path: draft.path.trim(), ...common } };
  if (draft.kind === 'r2') {
    const written = draft.accessKeyId.trim() && draft.secretAccessKey.trim();
    return {
      settings: {
        kind: 'r2',
        accountId: draft.accountId.trim(),
        bucket: draft.bucket.trim(),
        publicUrl,
        ...(draft.zoneId.trim() ? { zoneId: draft.zoneId.trim() } : {}),
      },
      ...(written
        ? {
            key: {
              accessKeyId: draft.accessKeyId.trim(),
              secretAccessKey: draft.secretAccessKey.trim(),
              ...(draft.purgeToken.trim() ? { purgeToken: draft.purgeToken.trim() } : {}),
            },
          }
        : {}),
    };
  }
  const server = {
    host: draft.host.trim(),
    user: draft.user.trim(),
    root: draft.root.trim(),
    ...(draft.port.trim() ? { port: Number(draft.port) } : {}),
    ...common,
  };
  if (draft.kind === 'ftp') {
    return {
      settings: {
        kind: 'ftp',
        ...server,
        tls: draft.tls,
        ...(draft.tls === 'none' ? { allowUnencrypted: draft.allowUnencrypted } : {}),
      },
      ...(draft.password ? { key: { password: draft.password } } : {}),
    };
  }
  const key: MediaKey =
    draft.auth === 'key'
      ? {
          privateKey: draft.privateKey,
          ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
        }
      : { password: draft.password };
  const written = draft.auth === 'key' ? draft.privateKey.trim() : draft.password;
  return {
    settings: { kind: 'sftp', ...server, ...(hostKey ? { hostKey } : {}) },
    ...(written ? { key } : {}),
  };
}

/** A host key the server showed, to be confirmed by an admin who checked it. */
function ConfirmHostKey({
  shown,
  busy,
  onConfirm,
}: {
  shown: HostKeyToConfirm;
  busy: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  const changed = shown.code === 'host-key-changed';
  return (
    <div className={changed ? 'settings-confirm changed' : 'settings-confirm'} role="alert">
      <strong>
        {t(changed ? 'settings.media.confirmChangedTitle' : 'settings.media.confirmTitle')}
      </strong>
      <code className="token-value" dir="ltr">
        {shown.fingerprint}
      </code>
      {changed && <p className="warn small">{t('settings.media.confirmChanged')}</p>}
      <p className="small">{t('settings.media.confirmExplain')}</p>
      <code className="token-example" dir="ltr">
        ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
      </code>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {t('settings.media.confirm')}
        </button>
      </div>
    </div>
  );
}

function MediaPart({ values, onSaved }: { values: Values; onSaved: () => void }) {
  const t = useT();
  const [uiLang] = useLang();
  const [draft, setDraft] = useState(() => draftOf(values.media));
  const [confirm, setConfirm] = useState<HostKeyToConfirm>();
  const work = useWork();
  const set =
    <K extends keyof Draft>(name: K) =>
    (value: Draft[K]) =>
      setDraft((was) => ({ ...was, [name]: value }));
  const text = (name: keyof Draft) => ({
    value: draft[name] as string,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(name)(event.target.value),
  });

  const told = (test: StoreTest): Note => ({
    ok: test.wrote,
    say: (t, lang) =>
      !test.wrote
        ? t('settings.media.unreachable', { error: test.message ?? '' })
        : test.library
          ? t('settings.media.reachedLibrary', {
              when: when(lang, test.library.published),
              files: t('library.fileMany', { count: test.library.files }),
            })
          : t('settings.media.reachedEmpty'),
  });

  // The key kept is the store's of this kind; another kind comes with its own.
  const kept =
    values.media.key.set && values.media.kind === draft.kind ? values.media.key : undefined;
  const sameServer =
    values.media.kind === 'sftp' &&
    values.media.host === draft.host.trim() &&
    String(values.media.port ?? '') === draft.port.trim();

  const keep = (hostKey?: string) =>
    work.run(async () => {
      const { settings, key } = settingsOf(draft, hostKey);
      const answer = await settingsApi.media(settings, key);
      if ('confirm' in answer) {
        setConfirm(answer.confirm);
        return undefined;
      }
      setConfirm(undefined);
      setDraft((was) => ({
        ...was,
        privateKey: '',
        passphrase: '',
        password: '',
        accessKeyId: '',
        secretAccessKey: '',
        purgeToken: '',
      }));
      onSaved();
      return told(answer.test);
    });
  const save = (event: FormEvent) => {
    event.preventDefault();
    keep(sameServer ? values.media.hostKey : undefined);
  };
  const test = () =>
    work.run(async () => {
      const tried = await settingsApi.test();
      if (tried.hostKey) setConfirm(tried.hostKey);
      return told(tried);
    });

  const readKeyFile = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void file.text().then(set('privateKey'));
  };

  const address = values.media.address;
  const policy = [
    "New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Slidr' -Force | Out-Null",
    "New-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Slidr' -Name MediaLibraryUrl `",
    `  -PropertyType String -Value '${address}' -Force`,
  ].join('\n');
  // The released installer, under its own name (docs/media-library.md in the app).
  const installer = `Slidr_<version>_x64-setup.exe /S /MEDIA="${address}"`;
  const server = draft.kind !== 'folder';
  const keyHint = kept?.at
    ? t('settings.media.keyKept', { when: when(uiLang, kept.at) })
    : undefined;

  return (
    <form className="settings-part" onSubmit={save}>
      <h3>{t('settings.media.title')}</h3>
      <p className="small">{t('settings.media.explain')}</p>
      {!values.editable.media && <p className="settings-kind">{t(KINDS[values.media.kind])}</p>}
      {values.editable.media && (
        <>
          <Field label={t('settings.media.where')}>
            <select
              value={draft.kind}
              onChange={(event) => {
                set('kind')(event.target.value as Kind);
                setConfirm(undefined);
              }}
            >
              {(['folder', 'sftp', 'ftp', 'r2'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {t(kind === 'r2' ? R2_KIND : KINDS[kind])}
                </option>
              ))}
            </select>
          </Field>
          {draft.kind === 'folder' ? (
            <Field label={t('settings.media.path')} hint={t('settings.media.pathHint')}>
              <input required dir="ltr" placeholder="D:\\Slidr\\media" {...text('path')} />
            </Field>
          ) : draft.kind === 'r2' ? (
            <>
              <div className="settings-server two">
                <Field label={t('settings.media.accountId')}>
                  <input required dir="ltr" pattern="[0-9a-f]{32}" {...text('accountId')} />
                </Field>
                <Field label={t('settings.media.bucket')}>
                  <input required dir="ltr" placeholder="slidr-media" {...text('bucket')} />
                </Field>
              </div>
              <Field
                label={t('settings.media.domain')}
                hint={isolate(t('settings.media.domainHint'))}
              >
                <input
                  type="url"
                  required
                  dir="ltr"
                  placeholder="https://media.example.org/"
                  {...text('publicUrl')}
                />
              </Field>
              <Field
                label={t('settings.media.accessKeyId')}
                hint={keyHint ?? t('settings.media.s3Hint')}
              >
                <input
                  dir="ltr"
                  autoComplete="off"
                  required={!kept}
                  placeholder={kept ? '••••••••' : ''}
                  {...text('accessKeyId')}
                />
              </Field>
              <Field label={t('settings.media.secretAccessKey')}>
                <input
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  required={!kept}
                  placeholder={kept ? '••••••••' : ''}
                  {...text('secretAccessKey')}
                />
              </Field>
              <Field label={t('settings.media.zoneId')} hint={t('settings.media.zoneIdHint')}>
                <input dir="ltr" pattern="[0-9a-f]{32}" {...text('zoneId')} />
              </Field>
              <Field
                label={t('settings.media.purgeToken')}
                hint={t('settings.media.purgeTokenHint')}
              >
                <input
                  type="password"
                  dir="ltr"
                  autoComplete="new-password"
                  required={Boolean(draft.zoneId.trim()) && !kept}
                  placeholder={kept ? '••••••••' : ''}
                  {...text('purgeToken')}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="settings-server">
                <Field label={t('settings.media.host')}>
                  <input required dir="ltr" placeholder="files.example.org" {...text('host')} />
                </Field>
                <Field label={t('settings.media.port')}>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    dir="ltr"
                    placeholder={
                      draft.kind === 'sftp' ? '22' : draft.tls === 'implicit' ? '990' : '21'
                    }
                    {...text('port')}
                  />
                </Field>
                <Field label={t('settings.media.user')}>
                  <input required dir="ltr" autoComplete="off" {...text('user')} />
                </Field>
              </div>
              <Field label={t('settings.media.root')} hint={isolate(t('settings.media.rootHint'))}>
                <input
                  required
                  dir="ltr"
                  pattern="/.*"
                  placeholder="/var/www/media"
                  {...text('root')}
                />
              </Field>
              {draft.kind === 'ftp' && (
                <Field label={t('settings.media.tls')}>
                  <select
                    value={draft.tls}
                    onChange={(event) => set('tls')(event.target.value as Draft['tls'])}
                  >
                    {(['explicit', 'implicit', 'none'] as const).map((tls) => (
                      <option key={tls} value={tls}>
                        {t(`settings.media.tls.${tls}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {draft.kind === 'ftp' && draft.tls === 'none' && (
                <label className="settings-check warn small">
                  <input
                    type="checkbox"
                    required
                    checked={draft.allowUnencrypted}
                    onChange={(event) => set('allowUnencrypted')(event.target.checked)}
                  />
                  {t('settings.media.allowUnencrypted')}
                </label>
              )}
              {draft.kind === 'sftp' && (
                <Field label={t('settings.media.auth')}>
                  <select
                    value={draft.auth}
                    onChange={(event) => set('auth')(event.target.value as Draft['auth'])}
                  >
                    <option value="key">{t('settings.media.auth.key')}</option>
                    <option value="password">{t('settings.media.auth.password')}</option>
                  </select>
                </Field>
              )}
              {draft.kind === 'sftp' && draft.auth === 'key' ? (
                <>
                  <Field label={t('settings.media.privateKey')} hint={keyHint}>
                    <textarea
                      rows={4}
                      dir="ltr"
                      spellCheck={false}
                      autoComplete="off"
                      required={!kept}
                      placeholder={kept ? '••••••••' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                      {...text('privateKey')}
                    />
                  </Field>
                  <label className="settings-file small">
                    <input type="file" onChange={(event) => readKeyFile(event.target.files)} />
                    {t('settings.media.privateKeyFile')}
                  </label>
                  <Field label={t('settings.media.passphrase')}>
                    <input
                      type="password"
                      dir="ltr"
                      autoComplete="new-password"
                      {...text('passphrase')}
                    />
                  </Field>
                </>
              ) : (
                <Field label={t('settings.media.password')} hint={keyHint}>
                  <input
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    required={!kept}
                    placeholder={kept ? '••••••••' : ''}
                    {...text('password')}
                  />
                </Field>
              )}
              {draft.kind === 'sftp' && sameServer && values.media.hostKey && (
                <Field label={t('settings.media.hostKey')}>
                  <span className="settings-hostkey small">
                    <code dir="ltr">{values.media.hostKey}</code>
                    <span className="ok">{t('settings.media.hostKeyConfirmed')}</span>
                  </span>
                </Field>
              )}
            </>
          )}
          {draft.kind !== 'r2' && (
            <Field
              label={t('settings.media.publicUrl')}
              hint={isolate(
                t(server ? 'settings.media.publicUrlRemoteHint' : 'settings.media.publicUrlHint'),
              )}
            >
              <input
                type="url"
                dir="ltr"
                placeholder="https://media.example.org/slidr/"
                {...text('publicUrl')}
              />
            </Field>
          )}
        </>
      )}
      {confirm && (
        <ConfirmHostKey
          shown={confirm}
          busy={work.busy}
          onConfirm={() => keep(confirm.fingerprint)}
        />
      )}
      <div className="row">
        {values.editable.media && (
          <button type="submit" className="primary" disabled={work.busy}>
            {t('settings.media.saveTested')}
          </button>
        )}
        {values.media.kind !== 'none' && (
          <button type="button" disabled={work.busy} onClick={test}>
            {work.busy ? t('settings.media.testing') : t('settings.media.test')}
          </button>
        )}
      </div>
      <Said note={work.note} />
      {values.media.kind === 'ftp' && values.media.tls === 'none' && (
        <p className="warn small">{t('settings.media.unencrypted')}</p>
      )}

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
    </form>
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
  onSaved,
}: {
  values: Values;
  /** Whether the owner signs in by a link of this machine, without a provider. */
  local: boolean;
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
  const [tenant, setTenant] = useState(tenantOf(set?.issuer) ?? 'organizations');
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

  if (!values.editable.signIn) {
    return (
      <section className="settings-part">
        <h3>{t('settings.signIn.title')}</h3>
        <p className="small">
          {t(values.signIn?.host ? 'settings.signIn.host' : 'settings.signIn.hostNone')}
        </p>
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
      <LibraryPart values={values} onSaved={onSaved} />
      <MediaPart values={values} onSaved={onSaved} />
      {values.media.kind !== 'none' && <SeedPart key={values.media.path} />}
      <SignInPart values={values} local={access.value.local} onSaved={onSaved} />
      <LimitsPart values={values} onSaved={onSaved} />
    </div>
  );
}
