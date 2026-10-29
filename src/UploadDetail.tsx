import { CONTENT_LANGUAGES, languageDir, type ContentLanguage } from '@slidr/model';
import { Fragment, useMemo, useState, type ChangeEvent } from 'react';
import { designAssetsModule, designsModule, templatesModule } from './app';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey, type Translate } from './i18n';
import { LanguagePicker, nativeName, type Lang } from './languages';
import { ItemOverlay } from './Overlay';
import { useRead } from './shared';
import { DesignPreview, SampleSheet, sampleDeckOf, type PictureSource } from './uploadPreview';
import {
  ApiError,
  TAGGED,
  kindKey,
  kindOf,
  statusKey,
  subjectOf,
  unavailable,
  when,
  who,
  languageOfFile,
  readContent,
  settled,
  readJsonFile,
  uploadsApi,
  type Access,
  type Issue,
  type Kind,
  type LanguagePart,
  type Status,
  type Tagged,
  type Upload,
} from './uploadsApi';

/**
 * The languages each kind of upload is written in (`server/core/uploads`: designs.ts, templates.ts,
 * tags.ts).
 */
const OTHERS = CONTENT_LANGUAGES.filter((lang) => lang !== 'he' && lang !== 'en');
const BASE: readonly ContentLanguage[] = ['he', 'en'];
export const RULES: Record<
  Kind,
  { allowed: readonly ContentLanguage[]; required: readonly ContentLanguage[] }
> = {
  'designs:add': { allowed: CONTENT_LANGUAGES, required: BASE },
  'designs:translate': { allowed: OTHERS, required: [] },
  'designs:draw': { allowed: CONTENT_LANGUAGES, required: [] },
  'templates:translate': { allowed: OTHERS, required: [] },
  ...(Object.fromEntries(
    TAGGED.map((type) => [`${type}:tag`, { allowed: BASE, required: BASE }]),
  ) as Record<
    `${Tagged}:tag`,
    { allowed: readonly ContentLanguage[]; required: readonly ContentLanguage[] }
  >),
};

/** The most items of a part's tags drawn at once: the icons are some seven thousand. */
const TAGS_SHOWN = 400;

/** The search tags of a part's items in one language, each under its key. */
function TagStage({ upload, lang }: { upload: Upload; lang: ContentLanguage }) {
  const t = useT();
  const tags = upload.languages[lang]?.tags;
  const entries = tags && !Array.isArray(tags) ? Object.entries(tags) : [];
  return (
    <section className="upload-tags">
      <p className="muted small">{t('uploads.tags.items', { count: entries.length })}</p>
      <dl className="facts" lang={lang} dir={languageDir(lang)}>
        {entries.slice(0, TAGS_SHOWN).map(([key, words]) => (
          <Fragment key={key}>
            <dt dir="ltr">{key}</dt>
            <dd>{words.join(', ')}</dd>
          </Fragment>
        ))}
      </dl>
      {entries.length > TAGS_SHOWN && <p className="muted small">…</p>}
    </section>
  );
}

/** The issues of an answer, by the language they are in; general ones first. */
export function IssueList({
  issues,
  title,
  local,
}: {
  issues: readonly Issue[];
  title?: string;
  /** Issues the page found itself, in its own words; the server's are in English. */
  local?: boolean;
}) {
  const t = useT();
  if (issues.length === 0) return null;
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.language ?? '';
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return (
    <section className="upload-issues" role="alert">
      <h3>{title ?? t('uploads.issues.title')}</h3>
      {[...groups].map(([lang, found]) => (
        <div key={lang}>
          <h4>{lang ? nativeName(lang as Lang) : t('uploads.issues.general')}</h4>
          <ul className="findings">
            {found.map((issue, index) => (
              <li key={index} className="severe">
                {!local && <code dir="ltr">{issue.path}</code>}
                {local ? (
                  <span>{isolate(issue.message)}</span>
                ) : (
                  <span dir="ltr">{issue.message}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** A button that chooses files. */
export function FileButton({
  label,
  accept,
  multiple,
  disabled,
  onFiles,
  className,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  className?: string;
}) {
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length) onFiles(files);
  };
  return (
    <label className={`file-button ${className ?? ''}`} aria-disabled={disabled}>
      {label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={choose}
      />
    </label>
  );
}

/**
 * The content of each language in files, by the language each file is named for (`fr.json`), or
 * that a file names itself (`{ "fr": … }`); and the issues of the files that say neither.
 */
export async function partsOfFiles(
  files: File[],
  t: Translate,
  /** The language a single file is for, whatever its name. */
  forLanguage?: ContentLanguage,
): Promise<{
  parts: Partial<Record<ContentLanguage, LanguagePart>>;
  issues: Issue[];
  /** Whole uploads, as the API takes them. */
  uploads: Record<string, unknown>[];
}> {
  const parts: Partial<Record<ContentLanguage, LanguagePart>> = {};
  const issues: Issue[] = [];
  const uploads: Record<string, unknown>[] = [];
  for (const file of files) {
    let json: unknown;
    try {
      json = await readJsonFile(file);
    } catch {
      issues.push({ path: file.name, message: t('uploads.form.notJson', { name: file.name }) });
      continue;
    }
    const read = readContent(json);
    if (read?.kind === 'upload') uploads.push(read.upload);
    else if (read?.kind === 'languages') Object.assign(parts, read.parts);
    else if (read?.kind === 'part') {
      const lang = (files.length === 1 ? forLanguage : undefined) ?? languageOfFile(file.name);
      if (lang) parts[lang] = read.part;
      else
        issues.push({
          path: file.name,
          message: t('uploads.form.unknownFile', { name: file.name }),
        });
    } else {
      issues.push({
        path: file.name,
        message: t('uploads.form.unknownContent', { name: file.name }),
      });
    }
  }
  return { parts, issues, uploads };
}

/**
 * The picture of a published design, as the gallery draws it: of the English designs, which every
 * design is written in, since they know the sizes of the studio's pictures.
 */
async function publishedPicture(id: string) {
  const [designs, assets] = await Promise.all([
    designsModule().then((module) => module.loadDesigns('en')),
    designAssetsModule(),
  ]);
  const source = (asset?: ReturnType<typeof designs.previewAsset>): PictureSource | undefined => {
    const url = asset ? assets.designAssetUrl(asset) : undefined;
    return url && asset ? { url, width: asset.width, height: asset.height } : undefined;
  };
  return {
    picture: source(designs.previewAsset(id)),
    backdrop: source(designs.previewBackdrop(id)),
  };
}

function TemplateStage({ upload, lang }: { upload: Upload; lang: ContentLanguage }) {
  const t = useT();
  const [current, setCurrent] = useState(0);
  const sample = upload.languages[lang]?.sample;
  const drawn = useRead(async () => {
    const { builtIn } = await templatesModule();
    const template = builtIn.find((one) => one.theme.id === upload.target);
    if (!template || !sample) return undefined;
    return sampleDeckOf(template, sample, lang);
  }, [upload, lang]);
  if (drawn.error) return <p className="error-text">{drawn.error}</p>;
  if (!drawn.value) return <p className="muted">{t('library.loading')}</p>;
  return (
    <SampleSheet
      deck={drawn.value.deck}
      resolve={drawn.value.resolve}
      current={current}
      onCurrent={setCurrent}
    />
  );
}

/** The pictures a design's slides are drawn with: its own, or the published design's. */
export function useDesignPictures(upload: Upload) {
  const published = useRead(
    () =>
      upload.action === 'translate' ? publishedPicture(upload.target) : Promise.resolve(undefined),
    [upload.target, upload.action],
  );
  const own = (name: string): PictureSource | undefined => {
    const file = upload.files[name];
    return file ? { url: file.url, width: file.width, height: file.height } : undefined;
  };
  return upload.action === 'add'
    ? { picture: own('picture'), backdrop: own('backdrop') }
    : { picture: published.value?.picture, backdrop: published.value?.backdrop };
}

function DesignStage({ upload, lang }: { upload: Upload; lang: ContentLanguage }) {
  const t = useT();
  const { picture, backdrop } = useDesignPictures(upload);
  const written = CONTENT_LANGUAGES.filter((one) => upload.languages[one]);
  const notSlide = (problem: string) => t('uploads.form.notSlide', { error: problem });
  return (
    <>
      <DesignPreview
        slide={upload.languages[lang]?.slide}
        lang={lang}
        picture={picture}
        backdrop={backdrop}
        subject={upload.fields.subject}
        notSlide={notSlide}
      />
      {written.length > 1 && (
        <>
          <h3>{t('uploads.detail.everyLanguage')}</h3>
          <div className="thumbs">
            {written.map((one) => (
              <figure key={one}>
                <DesignPreview
                  slide={upload.languages[one]?.slide}
                  lang={one}
                  picture={picture}
                  backdrop={backdrop}
                  width={256}
                  notSlide={notSlide}
                />
                <figcaption lang={one} dir="auto">
                  {nativeName(one)}
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** A drawing (`designs: draw`): the picture of each slide it brings, as the galleries show it. */
function DrawStage({ upload, lang }: { upload: Upload; lang: ContentLanguage }) {
  const t = useT();
  const drawn = CONTENT_LANGUAGES.filter((one) => upload.files[`thumb-${one}`]);
  const shown = upload.files[`thumb-${lang}`];
  return (
    <>
      {shown && (
        <img
          src={shown.url}
          alt=""
          width={640}
          height={360}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )}
      {drawn.length > 1 && (
        <>
          <h3>{t('uploads.detail.everyLanguage')}</h3>
          <div className="thumbs">
            {drawn.map((one) => (
              <figure key={one}>
                <img src={upload.files[`thumb-${one}`]!.url} alt="" width={256} height={144} />
                <figcaption lang={one} dir="auto">
                  {nativeName(one)}
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Publishes one accepted upload (Try again), and answers it as it now is: published; pending
 * again, with a note, when it no longer holds; or still waiting, saying why.
 */
async function publishOne(id: string): Promise<Upload> {
  try {
    await uploadsApi.publish([id]);
  } catch (error) {
    // What could not be written, or not now, the upload itself tells.
    if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 502)) {
      throw error;
    }
  }
  return uploadsApi.get(id);
}

/** An approved upload that is not written yet: why, its tries, and when it is tried again. */
function Waiting({ waiting }: { waiting: NonNullable<Upload['publication']> }) {
  const t = useT();
  const [uiLang] = useLang();
  const { attempts, next } = waiting;
  return (
    <div className="upload-waiting small" role="status">
      <strong>{t('publications.waiting')}</strong>
      <span dir="auto">{waiting.message}</span>
      <span className="muted">
        {attempts === 0
          ? t('publications.waitingSoon')
          : next
            ? t('publications.waitingNext', { attempts, when: when(uiLang, next) })
            : t('publications.waitingByHand', { attempts })}
      </span>
    </div>
  );
}

/** What a person may do to an upload in its status, and what it takes. */
function StatusActions({
  upload,
  busy,
  act,
}: {
  upload: Upload;
  busy: boolean;
  act: (status: Status, note?: string) => void;
}) {
  const t = useT();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const missing = upload.missing.length;
  if (rejecting) {
    return (
      <div className="upload-reject">
        <label className="field">
          <span>{t('uploads.detail.rejectNote')}</span>
          <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => act('rejected', note.trim() || undefined)}
          >
            {t('uploads.detail.rejectConfirm')}
          </button>
          <button type="button" className="ghost" onClick={() => setRejecting(false)}>
            {t('uploads.form.cancel')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="form-actions">
      {upload.status === 'pending' && (
        <button
          type="button"
          className="primary"
          disabled={busy || missing > 0}
          onClick={() => act('accepted')}
        >
          {t('uploads.detail.accept')}
        </button>
      )}
      {upload.status === 'accepted' && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          title={upload.publication ? undefined : t('uploads.detail.publishedHint')}
          onClick={() => act('published')}
        >
          {upload.publication ? t('publications.tryAgain') : t('uploads.detail.published')}
        </button>
      )}
      {(upload.status === 'accepted' || upload.status === 'rejected') && (
        <button type="button" disabled={busy} onClick={() => act('pending')}>
          {t('uploads.detail.reopen')}
        </button>
      )}
      {(upload.status === 'pending' || upload.status === 'accepted') && (
        <button type="button" disabled={busy} onClick={() => setRejecting(true)}>
          {t('uploads.detail.reject')}
        </button>
      )}
      {upload.status === 'pending' && missing > 0 && (
        <p className="hint">{t('uploads.detail.acceptMissing', { count: missing })}</p>
      )}
    </div>
  );
}

/** Each language an upload may be written in: written or not, and changed one at a time. */
function Languages({
  upload,
  shown,
  onShow,
  busy,
  editable,
  onPut,
  onRemove,
}: {
  upload: Upload;
  shown: ContentLanguage;
  onShow: (lang: ContentLanguage) => void;
  busy: boolean;
  editable: boolean;
  onPut: (files: File[], lang?: ContentLanguage) => void;
  onRemove: (lang: ContentLanguage) => void;
}) {
  const t = useT();
  const rules = RULES[kindOf(upload)];
  return (
    <section>
      <h3>{t('uploads.detail.languages')}</h3>
      <ul className="upload-langs">
        {rules.allowed.map((lang) => {
          const written = upload.languages[lang] !== undefined;
          const required = rules.required.includes(lang);
          return (
            <li key={lang} className={written ? 'written' : 'missing'}>
              <button
                type="button"
                className="link"
                disabled={!written}
                aria-pressed={written && lang === shown}
                onClick={() => onShow(lang)}
                lang={lang}
              >
                <span aria-hidden>{written ? '✓' : '○'}</span> {nativeName(lang)}
              </button>
              <span className="muted small">
                {required
                  ? t('uploads.detail.required')
                  : written
                    ? t('uploads.detail.written')
                    : upload.missing.includes(lang)
                      ? t('uploads.detail.missing')
                      : ''}
              </span>
              {editable && (
                <span className="upload-lang-actions">
                  <FileButton
                    className="small"
                    label={written ? t('uploads.detail.replace') : t('uploads.detail.add')}
                    accept="application/json,.json"
                    disabled={busy}
                    onFiles={(files) => onPut(files, lang)}
                  />
                  {written && !required && (
                    <button
                      type="button"
                      className="ghost small"
                      disabled={busy}
                      aria-label={t('uploads.detail.remove')}
                      title={t('uploads.detail.remove')}
                      onClick={() => onRemove(lang)}
                    >
                      ✕
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <>
          <FileButton
            label={t('uploads.detail.addFiles')}
            accept="application/json,.json"
            multiple
            disabled={busy}
            onFiles={(files) => onPut(files)}
          />
          <p className="hint">{isolate(t('uploads.detail.filesHint'))}</p>
        </>
      )}
    </section>
  );
}

/** One upload up close: drawn in each of its languages, beside its status, languages and history. */
export function UploadDetail({
  id,
  lang: initial,
  access,
  onClose,
  onChanged,
  onGone,
}: {
  id: string;
  lang: Lang;
  access?: Access;
  onClose: () => void;
  onChanged: () => void;
  onGone: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const read = useRead(() => settled(uploadsApi.get(id)), [id]);
  const failed = read.value?.failed ?? read.error;
  const [changed, setChanged] = useState<Upload>();
  const upload = changed ?? read.value?.found;
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [failure, setFailure] = useState<string>();
  const [chosen, setChosen] = useState<ContentLanguage>();
  /** The files the approval just wrote into the library. */
  const [wrote, setWrote] = useState<string[]>();
  const written = useMemo(
    () => CONTENT_LANGUAGES.filter((one) => upload?.languages[one] !== undefined),
    [upload],
  );
  const shown =
    chosen && written.includes(chosen)
      ? chosen
      : written.includes(initial)
        ? initial
        : (written[0] ?? 'he');
  /** Does a change, and shows the upload as it now is, or what was wrong. */
  async function act(work: () => Promise<Upload | undefined>) {
    setBusy(true);
    setIssues([]);
    setFailure(undefined);
    try {
      const next = await work();
      if (next) setChanged(next);
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.issues.length) setIssues(error.issues);
      else setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const putFiles = (files: File[], only?: ContentLanguage) =>
    act(async () => {
      // A file chosen for one language is that language's, whatever its name.
      const { parts, issues: unread } = await partsOfFiles(files, t, only);
      let last: Upload | undefined;
      const found = [...unread];
      const todo = Object.entries(parts) as [ContentLanguage, LanguagePart][];
      for (const [lang, part] of todo) {
        try {
          last = await uploadsApi.putLanguage(id, lang, part);
          setChanged(last);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          found.push(
            ...(error.issues.length
              ? error.issues
              : [{ path: lang, message: error.message, language: lang }]),
          );
        }
      }
      if (found.length) {
        if (last) onChanged();
        throw new ApiError(422, 'invalid', '', found);
      }
      if (todo[0]) setChosen(todo[0][0]);
      return last;
    });

  if (failed !== undefined && !upload) {
    return (
      <ItemOverlay title={t('uploads.nav')} onClose={onClose}>
        <p className="error-text">{unavailable(t, failed, access)}</p>
      </ItemOverlay>
    );
  }
  if (!upload) {
    return (
      <ItemOverlay title={t('uploads.nav')} onClose={onClose}>
        <p className="muted">{t('library.loading')}</p>
      </ItemOverlay>
    );
  }

  const pending = upload.status === 'pending';
  const mayUpload = access?.mayUpload ?? false;
  const mayReview = access?.mayReview ?? false;
  const names = upload.languages.he?.name ?? upload.languages.en?.name;
  const withdrawable = mayUpload && (pending || upload.status === 'rejected');
  // A design's own tags, in the language shown; a part's tags are the stage itself.
  const ownTags = upload.languages[shown]?.tags;

  return (
    <ItemOverlay
      title={
        upload.action === 'tag' ? (
          subjectOf(t, upload)
        ) : (
          <>
            {names && <>{names} · </>}
            <span dir="ltr" className="upload-target">
              {upload.target}
            </span>
          </>
        )
      }
      subtitle={
        <>
          {t(kindKey(upload))} ·{' '}
          <span className={`badge status-badge ${upload.status}`}>
            {t(statusKey(upload.status))}
          </span>
        </>
      }
      actions={
        written.length > 1 ? (
          <LanguagePicker langs={written} lang={shown} onChange={setChosen} />
        ) : undefined
      }
      onClose={onClose}
      side={
        <>
          <section className="approve-box">
            <h3>{t('uploads.detail.status')}</h3>
            <p className="small">
              <span className={`badge status-badge ${upload.status}`}>
                {t(statusKey(upload.status))}
              </span>{' '}
              {t(`uploads.detail.about.${upload.status}` as MessageKey)}
            </p>
            {upload.note && (
              <p className="small upload-note" dir="auto">
                {upload.note}
              </p>
            )}
            {upload.status === 'accepted' && upload.publication && (
              <Waiting waiting={upload.publication} />
            )}
            {upload.status === 'published' && wrote && (
              <div className="upload-wrote small">
                <span>{t('publications.written')}</span>
                <ul>
                  {wrote.map((path) => (
                    <li key={path}>
                      <bdi dir="ltr">{path}</bdi>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {mayReview && (
              <StatusActions
                upload={upload}
                busy={busy}
                act={(status, note) =>
                  void act(async () => {
                    if (status === 'published') return publishOne(id);
                    const approved = await uploadsApi.setStatus(id, status, note);
                    const mine = approved.publishing?.publication?.uploads.find(
                      (one) => one.id === id,
                    );
                    setWrote(mine?.paths);
                    return approved;
                  })
                }
              />
            )}
          </section>
          {failure && (
            <p className="error-text">{t('uploads.issues.failed', { error: failure })}</p>
          )}
          <IssueList issues={issues} />
          <Languages
            upload={upload}
            shown={shown}
            onShow={setChosen}
            busy={busy}
            editable={pending && mayUpload}
            onPut={(files, lang) => void putFiles(files, lang)}
            onRemove={(lang) => void act(() => uploadsApi.deleteLanguage(id, lang))}
          />
          <section>
            <h3>{t('uploads.detail.details')}</h3>
            <dl className="facts">
              <dt>{t('uploads.detail.target')}</dt>
              <dd dir="ltr">{upload.target}</dd>
              {upload.fields.group && (
                <>
                  <dt>{t('uploads.detail.group')}</dt>
                  <dd>
                    {upload.languages.he?.groupName ? `${upload.languages.he.groupName} · ` : ''}
                    <span dir="ltr">{upload.fields.group}</span>
                  </dd>
                </>
              )}
              {upload.fields.subject && (
                <>
                  <dt>{t('uploads.detail.subject')}</dt>
                  <dd dir="ltr">{upload.fields.subject.join(', ')}</dd>
                </>
              )}
              {Array.isArray(ownTags) && (
                <>
                  <dt>{t('uploads.kind.tag')}</dt>
                  <dd lang={shown} dir={languageDir(shown)}>
                    {ownTags.join(', ')}
                  </dd>
                </>
              )}
              {Object.entries(upload.files).map(([name, file]) => (
                <FileFact key={name} name={name} file={file} />
              ))}
              <dt>{t('uploads.detail.id')}</dt>
              <dd dir="ltr">{upload.id}</dd>
            </dl>
          </section>
          <section>
            <h3>{t('uploads.detail.history')}</h3>
            <ol className="upload-history small">
              {upload.history.map((entry, index) => (
                <li key={index}>
                  <span className={`badge status-badge ${entry.status}`}>
                    {t(statusKey(entry.status))}
                  </span>{' '}
                  <span className="muted">
                    {when(uiLang, entry.at)} ·{' '}
                    {entry.by.token
                      ? t('tokens.byToken', { who: who(entry.by.id), token: entry.by.token })
                      : who(entry.by.id)}
                  </span>
                  {entry.note && (
                    <span className="upload-note block" dir="auto">
                      {entry.note}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
          {withdrawable && (
            <details className="danger">
              <summary>{t('uploads.detail.withdraw')}</summary>
              <p className="small">{t('uploads.detail.withdrawConfirm')}</p>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await uploadsApi.withdraw(id);
                    onGone();
                    return undefined;
                  })
                }
              >
                {t('uploads.detail.withdraw')}
              </button>
            </details>
          )}
        </>
      }
    >
      {upload.action === 'tag' ? (
        <TagStage upload={upload} lang={shown} />
      ) : upload.type === 'templates' ? (
        <TemplateStage upload={upload} lang={shown} />
      ) : upload.action === 'draw' ? (
        <DrawStage upload={upload} lang={shown} />
      ) : (
        <DesignStage upload={upload} lang={shown} />
      )}
    </ItemOverlay>
  );
}

function FileFact({ name, file }: { name: string; file: Upload['files'][string] }) {
  return (
    <>
      <dt dir="ltr">{name}</dt>
      <dd dir="ltr">
        <a href={file.url} target="_blank" rel="noreferrer">
          {file.type}
        </a>
        <span className="muted block">
          {file.width && file.height ? `${file.width}×${file.height} · ` : ''}
          {Math.round(file.bytes / 1024)} KB
        </span>
      </dd>
    </>
  );
}
