import { CONTENT_LANGUAGES, type ContentLanguage } from '@slidr/model';
import { isolate } from './bidi';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { designsModule, messages, named, templatesModule } from './app';
import { useT, type MessageKey } from './i18n';
import { LanguagePicker, nativeName, type Lang } from './languages';
import { ItemOverlay } from './Overlay';
import { useRead } from './shared';
import { FileButton, IssueList, RULES, partsOfFiles } from './UploadDetail';
import {
  DesignPreview,
  SampleSheet,
  Unshown,
  sampleDeckOf,
  type PictureSource,
} from './uploadPreview';
import {
  ApiError,
  KINDS,
  idFromName,
  pictureCentre,
  readPicture,
  slideProblem,
  uploadsApi,
  type Issue,
  type Kind,
  type LanguagePart,
  type Picture,
  type Upload,
} from './uploadsApi';

type Parts = Partial<Record<ContentLanguage, LanguagePart>>;
type Names = { he: string; en: string };

/** The designs, every one of which is drawn in English, and their groups (ADR-109). */
const allDesigns = () => designsModule().then((designs) => designs.loadDesigns('en'));

const isWebp = (file: File) => file.type === 'image/webp' || /\.webp$/i.test(file.name);
/** A picture whose name says it lies under the other. */
const isBackdrop = (file: File) => /(?:-bg|backdrop)\.webp$/i.test(file.name);

const kindLabel = (kind: Kind) => `uploads.kind.${kind.replace(':', '.')}` as MessageKey;

/**
 * The designs uploads may translate, and the groups a new one may join: named as the app names
 * them, else as the catalog does (`Designs.tsx`).
 */
function useDesigns(lang: Lang) {
  const read = useRead(allDesigns, []);
  return useMemo(() => {
    const designs = read.value;
    if (!designs) return { designs: [], groups: [] };
    return {
      designs: designs.ids.map((id) => ({
        id,
        name:
          named(messages.elements, lang, 'designs', 'name', id) ??
          designs.designName(id, lang) ??
          id,
      })),
      groups: designs.groups.map((id) => ({
        id,
        name:
          named(messages.elements, lang, 'designs', 'group', id) ??
          designs.designGroupName(id, lang) ??
          id,
      })),
    };
  }, [read.value, lang]);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="hint">{isolate(hint)}</small>}
    </label>
  );
}

/** A picture chosen for the upload: shown small, with its size, and chosen again. */
function PictureField({
  label,
  hint,
  picture,
  onPicture,
  onClear,
}: {
  label: string;
  hint: string;
  picture?: Picture;
  onPicture: (file: File) => void;
  onClear?: () => void;
}) {
  const t = useT();
  return (
    <div className="field">
      <span>{label}</span>
      <div className="upload-picture-field">
        {picture && (
          <span className="checker upload-picture-thumb">
            <img src={picture.url} alt="" />
          </span>
        )}
        <div>
          <FileButton
            label={picture ? t('uploads.form.chooseAgain') : t('uploads.form.choose')}
            accept="image/webp,.webp"
            onFiles={([file]) => file && onPicture(file)}
          />
          {picture && (
            <small className="muted block" dir="ltr">
              {picture.file.name} · {picture.width}×{picture.height}
            </small>
          )}
          {picture && onClear && (
            <button type="button" className="link small" onClick={onClear}>
              {t('uploads.detail.remove')}
            </button>
          )}
        </div>
      </div>
      <small className="hint">{isolate(hint)}</small>
    </div>
  );
}

/** A template's sample, in the language chosen, as the template draws it. */
function SampleStage({
  target,
  sample,
  lang,
}: {
  target: string;
  sample: unknown[];
  lang: ContentLanguage;
}) {
  const t = useT();
  const [current, setCurrent] = useState(0);
  const drawn = useRead(async () => {
    const { builtIn } = await templatesModule();
    const template = builtIn.find((one) => one.theme.id === target);
    return template ? sampleDeckOf(template, sample, lang) : undefined;
  }, [target, sample, lang]);
  if (drawn.error) {
    return <Unshown>{t('uploads.form.notSample', { error: drawn.error })}</Unshown>;
  }
  if (!drawn.value) return <Unshown>{t('uploads.form.previewEmpty')}</Unshown>;
  return (
    <SampleSheet
      deck={drawn.value.deck}
      resolve={drawn.value.resolve}
      current={current}
      onCurrent={setCurrent}
    />
  );
}

/**
 * A new upload: what it is, its files, and its content in each language, read from the files
 * the person drops or chooses and drawn as the app will show it before anything is sent. The
 * server checks it as it is sent, and what does not hold is said by the field and the language.
 */
export function NewUpload({
  lang,
  onClose,
  onCreated,
}: {
  lang: Lang;
  onClose: () => void;
  onCreated: (upload: Upload) => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<Kind>('designs:add');
  const [picture, setPicture] = useState<Picture>();
  const [backdrop, setBackdrop] = useState<Picture>();
  /** The id as typed; until then, the English name's. */
  const [typedId, setTypedId] = useState<string>();
  const [group, setGroup] = useState('');
  /** The subject's point as placed; until then, the middle of the picture on the slide. */
  const [placed, setPlaced] = useState<[number, number]>();
  const [names, setNames] = useState<Names>({ he: '', en: '' });
  const [groupNames, setGroupNames] = useState<Names>({ he: '', en: '' });
  const [target, setTarget] = useState('');
  const [parts, setParts] = useState<Parts>({});
  const [chosen, setChosen] = useState<ContentLanguage>();
  const [unread, setUnread] = useState<Issue[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const known = useDesigns(lang);
  const templates = useRead(templatesModule, []);

  const rules = RULES[kind];
  const adds = kind === 'designs:add';
  const written = rules.allowed.filter((one) => parts[one] !== undefined);
  const shown =
    chosen && written.includes(chosen) ? chosen : written.includes(lang) ? lang : written[0];
  const wanting = rules.required.filter((one) => !parts[one]);
  const groupIsNew = group !== '' && !known.groups.some((one) => one.id === group);

  // The picture of the design being translated, as the gallery draws it.
  const published = useRead(async () => {
    if (kind !== 'designs:translate' || !target) return undefined;
    const assets = await import('@desktop/elements/designAssets');
    const source = (asset?: ReturnType<typeof assets.previewAsset>): PictureSource | undefined => {
      const url = asset ? assets.designAssetUrl(asset) : undefined;
      return url && asset ? { url, width: asset.width, height: asset.height } : undefined;
    };
    return {
      picture: source(assets.previewAsset(target)),
      backdrop: source(assets.previewBackdrop(target)),
    };
  }, [kind, target]);

  const id = typedId ?? (names.en.trim() ? idFromName(names.en) : '');
  // The point is of the slide as it reads from the left: the English one, or the Hebrew mirrored.
  const centre = useMemo((): [number, number] | undefined => {
    const english = parts.en?.slide;
    if (english && !slideProblem(english)) return pictureCentre(english);
    const hebrew = parts.he?.slide;
    const point = hebrew && !slideProblem(hebrew) ? pictureCentre(hebrew) : undefined;
    return point && [1920 - point[0], point[1]];
  }, [parts]);
  const subject = placed ?? centre;

  /** An upload as the API takes it, read from a file, put into the form. */
  function fill(body: Record<string, unknown>) {
    const next = `${String(body.type)}:${String(body.action)}` as Kind;
    if (!KINDS.includes(next)) return;
    setKind(next);
    const languages = (body.languages ?? {}) as Parts;
    if (next === 'designs:add') {
      if (typeof body.id === 'string') setTypedId(body.id);
      if (typeof body.group === 'string') setGroup(body.group);
      if (Array.isArray(body.subject)) setPlaced(body.subject as [number, number]);
      setNames({ he: languages.he?.name ?? '', en: languages.en?.name ?? '' });
      setGroupNames({ he: languages.he?.groupName ?? '', en: languages.en?.groupName ?? '' });
    } else if (typeof body.id === 'string') setTarget(body.id);
    setParts((before) => ({ ...before, ...languages }));
  }

  async function addFiles(files: File[]) {
    setIssues([]);
    const found: Issue[] = [];
    for (const file of files.filter(isWebp)) {
      try {
        const read = await readPicture(file);
        if (isBackdrop(file)) setBackdrop(read);
        else setPicture(read);
      } catch {
        found.push({ path: file.name, message: t('uploads.form.notPicture', { name: file.name }) });
      }
    }
    const {
      parts: more,
      issues: wrong,
      uploads,
    } = await partsOfFiles(
      files.filter((file) => !isWebp(file)),
      t,
    );
    uploads.forEach(fill);
    for (const code of Object.keys(more) as ContentLanguage[]) {
      if (!rules.allowed.includes(code) && uploads.length === 0) {
        found.push({
          path: code,
          message: t('uploads.form.notThisKind', { language: nativeName(code) }),
          language: code,
        });
        delete more[code];
      }
    }
    setParts((before) => ({ ...before, ...more }));
    setUnread([...wrong, ...found]);
    const first = Object.keys(more)[0] as ContentLanguage | undefined;
    if (first) setChosen(first);
  }

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  function bodyOf() {
    const [type, action] = kind.split(':');
    const languages: Parts = {};
    for (const code of CONTENT_LANGUAGES) {
      const part = parts[code];
      if (!part) continue;
      languages[code] =
        type === 'templates'
          ? { sample: part.sample }
          : adds && (code === 'he' || code === 'en')
            ? {
                name: names[code].trim(),
                ...(groupIsNew && groupNames[code].trim()
                  ? { groupName: groupNames[code].trim() }
                  : {}),
                slide: part.slide,
              }
            : { slide: part.slide };
    }
    return adds
      ? { type, action, id: id.trim(), group: group.trim(), subject, languages }
      : { type, action, id: target, languages };
  }

  async function send() {
    setBusy(true);
    setIssues([]);
    setFailure(undefined);
    try {
      const files = adds ? { picture: picture?.file, backdrop: backdrop?.file } : {};
      onCreated(await uploadsApi.create(bodyOf(), files));
    } catch (error) {
      if (error instanceof ApiError && error.issues.length) setIssues(error.issues);
      else setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    written.length > 0 &&
    wanting.length === 0 &&
    (adds
      ? Boolean(picture && id && group && subject && names.he.trim() && names.en.trim())
      : Boolean(target));
  const notSlide = (problem: string) => t('uploads.form.notSlide', { error: problem });
  const part = shown ? parts[shown] : undefined;
  const picked: { picture?: PictureSource; backdrop?: PictureSource } = adds
    ? {
        picture: picture && { url: picture.url, width: picture.width, height: picture.height },
        backdrop: backdrop && { url: backdrop.url, width: backdrop.width, height: backdrop.height },
      }
    : (published.value ?? {});

  let stage: ReactNode;
  if (!shown || !part) {
    stage = (
      <Unshown drop>
        <span className="upload-drop-icon" aria-hidden>
          ⤓
        </span>
        <p>{t('uploads.form.previewEmpty')}</p>
        <p className="muted small">
          {isolate(t(`uploads.form.languages.${kind.replace(':', '.')}` as MessageKey))}
        </p>
        <FileButton
          label={t('uploads.form.chooseFiles')}
          accept={adds ? 'application/json,.json,image/webp,.webp' : 'application/json,.json'}
          multiple
          onFiles={(files) => void addFiles(files)}
        />
      </Unshown>
    );
  } else if (kind === 'templates:translate') {
    stage = target ? (
      <SampleStage target={target} sample={part.sample ?? []} lang={shown} />
    ) : (
      <Unshown>{t('uploads.form.templateFirst')}</Unshown>
    );
  } else {
    stage = (
      <>
        <DesignPreview
          slide={part.slide}
          lang={shown}
          picture={picked.picture}
          backdrop={picked.backdrop}
          subject={adds ? subject : undefined}
          onPick={adds ? setPlaced : undefined}
          notSlide={notSlide}
        />
        {adds && <p className="hint">{t('uploads.form.subjectHint')}</p>}
      </>
    );
  }

  return (
    <ItemOverlay
      title={t('uploads.form.title')}
      subtitle={t(kindLabel(kind))}
      actions={
        written.length > 1 && shown ? (
          <LanguagePicker langs={written} lang={shown} onChange={setChosen} />
        ) : undefined
      }
      onClose={onClose}
      side={
        <form
          className="upload-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="field">
            <span>{t('uploads.form.kind')}</span>
            <div className="segmented upload-kinds" role="group">
              {KINDS.map((one) => (
                <button
                  type="button"
                  key={one}
                  aria-pressed={kind === one}
                  onClick={() => {
                    setKind(one);
                    setParts({});
                    setIssues([]);
                    setUnread([]);
                  }}
                >
                  {t(kindLabel(one))}
                </button>
              ))}
            </div>
          </div>

          {adds && (
            <>
              <PictureField
                label={t('uploads.form.picture')}
                hint={t('uploads.form.pictureHint')}
                picture={picture}
                onPicture={(file) => void readPicture(file).then(setPicture)}
              />
              <PictureField
                label={t('uploads.form.backdrop')}
                hint={t('uploads.form.backdropHint')}
                picture={backdrop}
                onPicture={(file) => void readPicture(file).then(setBackdrop)}
                onClear={() => setBackdrop(undefined)}
              />
              <div className="form-grid">
                <Field label={t('uploads.form.nameHe')}>
                  <input
                    dir="rtl"
                    lang="he"
                    value={names.he}
                    onChange={(e) => setNames({ ...names, he: e.target.value })}
                  />
                </Field>
                <Field label={t('uploads.form.nameEn')}>
                  <input
                    dir="ltr"
                    lang="en"
                    value={names.en}
                    onChange={(e) => setNames({ ...names, en: e.target.value })}
                  />
                </Field>
              </div>
              <Field label={t('uploads.form.id')} hint={t('uploads.form.idHint')}>
                <input
                  dir="ltr"
                  value={id}
                  pattern="m-[a-z0-9]+(-[a-z0-9]+)*"
                  onChange={(e) => setTypedId(e.target.value)}
                />
              </Field>
              <Field label={t('uploads.form.group')} hint={t('uploads.form.groupHint')}>
                <input
                  dir="ltr"
                  list="upload-groups"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                />
                <datalist id="upload-groups">
                  {known.groups.map((one) => (
                    <option key={one.id} value={one.id}>
                      {one.name}
                    </option>
                  ))}
                </datalist>
              </Field>
              {groupIsNew && (
                <div className="form-grid">
                  <Field label={t('uploads.form.groupHe')}>
                    <input
                      dir="rtl"
                      lang="he"
                      value={groupNames.he}
                      onChange={(e) => setGroupNames({ ...groupNames, he: e.target.value })}
                    />
                  </Field>
                  <Field label={t('uploads.form.groupEn')}>
                    <input
                      dir="ltr"
                      lang="en"
                      value={groupNames.en}
                      onChange={(e) => setGroupNames({ ...groupNames, en: e.target.value })}
                    />
                  </Field>
                </div>
              )}
              <div className="field">
                <span>{t('uploads.form.subject')}</span>
                <div className="upload-point" dir="ltr">
                  {[0, 1].map((axis) => (
                    <input
                      key={axis}
                      type="number"
                      min={0}
                      max={axis === 0 ? 1920 : 1080}
                      aria-label={axis === 0 ? 'x' : 'y'}
                      value={subject?.[axis] ?? ''}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        const next: [number, number] = [...(subject ?? [0, 0])];
                        next[axis] = value;
                        setPlaced(next);
                      }}
                    />
                  ))}
                </div>
                <small className="hint">{isolate(t('uploads.form.subjectHint'))}</small>
              </div>
            </>
          )}

          {kind === 'designs:translate' && (
            <Field label={t('uploads.form.design')}>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{t('uploads.form.designPick')}</option>
                {known.designs.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name} · {one.id}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {kind === 'templates:translate' && (
            <Field label={t('uploads.form.template')}>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{t('uploads.form.templatePick')}</option>
                {(templates.value?.builtIn ?? []).map((one) => (
                  <option key={one.theme.id} value={one.theme.id}>
                    {named(messages.templates, lang, 'name', one.theme.id) ?? one.theme.name} ·{' '}
                    {one.theme.id}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div
            className={dragging ? 'field upload-drop dragging' : 'field upload-drop'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            <span>{t('uploads.form.languages')}</span>
            <small className="hint">
              {isolate(t(`uploads.form.languages.${kind.replace(':', '.')}` as MessageKey))}
            </small>
            <div className="upload-drop-target">
              {t('uploads.form.drop')}{' '}
              <FileButton
                label={t('uploads.form.chooseFiles')}
                accept={adds ? 'application/json,.json,image/webp,.webp' : 'application/json,.json'}
                multiple
                onFiles={(files) => void addFiles(files)}
              />
            </div>
            <ul className="language-list">
              {rules.allowed.map((one) => {
                const has = parts[one] !== undefined;
                const required = rules.required.includes(one);
                return (
                  <li
                    key={one}
                    className={has ? 'language chosen-language' : 'language'}
                    lang={one}
                  >
                    <button
                      type="button"
                      className="link"
                      disabled={!has}
                      aria-pressed={has && one === shown}
                      onClick={() => setChosen(one)}
                    >
                      {has ? '✓' : required ? '•' : '○'} {nativeName(one)}
                    </button>
                    {has && (
                      <button
                        type="button"
                        className="ghost small"
                        aria-label={t('uploads.detail.remove')}
                        onClick={() => {
                          const { [one]: _gone, ...rest } = parts;
                          setParts(rest);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {wanting.length > 0 && (
              <small className="warn">
                {t('uploads.form.wanting', { languages: wanting.map(nativeName).join(', ') })}
              </small>
            )}
          </div>

          <IssueList issues={unread} title={t('uploads.form.unreadTitle')} local />
          <IssueList issues={issues} />
          {failure && (
            <p className="error-text">{t('uploads.issues.failed', { error: failure })}</p>
          )}

          <div className="form-actions">
            <button type="submit" className="primary" disabled={!ready || busy}>
              {busy ? t('uploads.form.submitting') : t('uploads.form.submit')}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              {t('uploads.form.cancel')}
            </button>
            <FileButton
              className="ghost"
              label={t('uploads.form.loadFile')}
              accept="application/json,.json"
              onFiles={(files) => void addFiles(files)}
            />
          </div>
        </form>
      }
    >
      <div
        className={dragging ? 'upload-stage dragging' : 'upload-stage'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        {stage}
      </div>
    </ItemOverlay>
  );
}
