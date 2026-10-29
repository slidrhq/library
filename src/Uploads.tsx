import { CONTENT_LANGUAGES, type ContentLanguage } from '@slidr/model';
import { useMemo, useState } from 'react';
import { signIn } from './account';
import { isolate } from './bidi';
import { useLang, useT } from './i18n';
import { LanguageNames, type Lang } from './languages';
import { WhenSeen } from './Lazy';
import { manifest, mediaUrl } from './media';
import { NewUpload } from './NewUpload';
import { matches, useRead, type LibraryRoute } from './shared';
import { UploadDetail, useDesignPictures } from './UploadDetail';
import { DesignPreview } from './uploadPreview';
import {
  ApiError,
  STATUSES,
  kindKey,
  readAccess,
  settled,
  statusKey,
  subjectOf,
  unavailable,
  uploadsApi,
  when,
  who,
  type Status,
  type Summary,
  type Upload,
} from './uploadsApi';

const NEW = 'new';

/** The picture that shows what an upload is: its own, the published design's, the template's. */
function pictureOf(upload: Summary, files: Record<string, unknown> | undefined) {
  // The tags of a part are words: they have no picture.
  if (upload.action === 'tag') return undefined;
  if (upload.type === 'designs') {
    return upload.action === 'add'
      ? `/api/uploads/${upload.id}/files/picture`
      : mediaUrl(`images/designs/${upload.target}.webp`);
  }
  const path = Object.keys(files ?? {}).find((one) =>
    one.startsWith(`images/templates/${upload.target}-`),
  );
  return path ? mediaUrl(path) : undefined;
}

/** The language a design's card shows its slide in: the page's, else English, else Hebrew. */
function cardLanguage(upload: Summary, lang: Lang) {
  const preferred: ContentLanguage[] = [lang, 'en', 'he'];
  return preferred.find((one) => upload.languages.includes(one)) ?? upload.languages[0];
}

/** A design's slide drawn from the upload, read when its card is seen; its picture without one. */
function DrawnDesign({
  id,
  lang,
  picture,
}: {
  id: string;
  lang: ContentLanguage;
  picture?: string;
}) {
  const read = useRead(() => uploadsApi.get(id), [id]);
  if (!read.value && !read.error) return null;
  const upload = read.value;
  if (!upload?.languages[lang]?.slide) {
    return picture ? <img src={picture} alt="" className="upload-card-image" /> : null;
  }
  return <DrawnSlide upload={upload} lang={lang} />;
}

function DrawnSlide({ upload, lang }: { upload: Upload; lang: ContentLanguage }) {
  const t = useT();
  const { picture, backdrop } = useDesignPictures(upload);
  return (
    <DesignPreview
      slide={upload.languages[lang]?.slide}
      lang={lang}
      picture={picture}
      backdrop={backdrop}
      notSlide={(problem) => t('uploads.form.notSlide', { error: problem })}
    />
  );
}

/**
 * A design's upload as the galleries will show it: its slide in a language, as the picture the
 * studio made of it ahead (`thumb-<language>`), or, where the upload has none, drawn from the
 * upload by the app's renderer. Its picture alone only when it has no slide in that language.
 */
function DesignCardSlide({
  upload,
  lang,
  picture,
}: {
  upload: Summary;
  lang: ContentLanguage;
  picture?: string;
}) {
  const [unmade, setUnmade] = useState(false);
  if (!unmade) {
    return (
      <img
        src={`/api/uploads/${upload.id}/files/thumb-${lang}`}
        alt=""
        lang={lang}
        loading="lazy"
        className="upload-card-image"
        onError={() => setUnmade(true)}
      />
    );
  }
  return (
    <WhenSeen>
      <DrawnDesign id={upload.id} lang={lang} picture={picture} />
    </WhenSeen>
  );
}

function UploadCard({
  upload,
  files,
  lang,
  onOpen,
}: {
  upload: Summary;
  files?: Record<string, unknown>;
  lang: Lang;
  onOpen: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const picture = pictureOf(upload, files);
  const adds = upload.action === 'add';
  const slideIn = upload.type === 'designs' && picture ? cardLanguage(upload, lang) : undefined;
  return (
    <button type="button" className="lib-card upload-card" onClick={onOpen}>
      <span
        className={
          upload.type === 'designs' ? 'upload-card-picture checker' : 'upload-card-picture'
        }
      >
        {slideIn ? (
          <DesignCardSlide key={slideIn} upload={upload} lang={slideIn} picture={picture} />
        ) : picture ? (
          <img src={picture} alt="" loading="lazy" className="upload-card-image" />
        ) : null}
        <span className={`badge status-badge ${upload.status}`}>{t(statusKey(upload.status))}</span>
      </span>
      <span className="lib-card-body">
        <span className="lib-card-title">
          {upload.action === 'tag' ? (
            subjectOf(t, upload)
          ) : (
            // An item's id, from left to right, at the start of the card as the other titles are.
            <span dir="ltr">{subjectOf(t, upload)}</span>
          )}
        </span>
        <span className="muted small">{t(kindKey(upload))}</span>
        <span className="lib-card-meta small">
          {adds ? (
            <span className={upload.languages.length === CONTENT_LANGUAGES.length ? 'ok' : 'warn'}>
              {t('uploads.languagesOf', {
                count: upload.languages.length,
                total: CONTENT_LANGUAGES.length,
              })}
            </span>
          ) : (
            <LanguageNames langs={upload.languages} />
          )}
        </span>
        <span className="muted small">
          {when(uiLang, upload.updated)} · {who(upload.by)}
        </span>
      </span>
    </button>
  );
}

/**
 * The uploads to the library, newest first, by their status: each opens up close, and a new one
 * is made here (`NewUpload`). The server checks each against the published library.
 */
export function Uploads({
  route,
  go,
  query,
  lang,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | undefined>();
  const [version, setVersion] = useState(0);
  const read = useRead(() => settled(uploadsApi.list()), [version]);
  const list = { value: read.value?.found, error: read.value?.failed ?? read.error };
  const access = useRead(readAccess, []);
  const files = useRead(manifest, []);
  const refresh = () => setVersion((at) => at + 1);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<string>();
  /** Writes every accepted upload into the library, and says what came of it. */
  const publishAccepted = () => {
    setPublishing(true);
    setPublished(undefined);
    uploadsApi
      .publish()
      .then(
        (done) =>
          setPublished(
            [
              t('uploads.publishDone', { count: done.uploads.length }),
              done.skipped.length
                ? t('publications.publishSkipped', { count: done.skipped.length })
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          ),
        (error: unknown) =>
          setPublished(
            t('uploads.issues.failed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
      )
      .finally(() => {
        setPublishing(false);
        refresh();
      });
  };

  const all = useMemo(() => list.value?.uploads ?? [], [list.value]);
  const shown = useMemo(
    () =>
      all.filter(
        (upload) =>
          (!status || upload.status === status) && matches(query, upload.target, upload.id),
      ),
    [all, status, query],
  );
  const count = (one?: Status) => all.filter((upload) => !one || upload.status === one).length;
  const mayUpload = access.value?.mayUpload ?? false;
  const mayPublish = access.value?.mayPublish ?? false;
  // Anyone signed in uploads: someone blocked is told why, and one signed out how to sign in.
  const refused =
    list.error instanceof ApiError && (list.error.status === 401 || list.error.status === 403);
  const signedOut =
    list.error instanceof ApiError && list.error.status === 401 && Boolean(access.value?.provider);
  const open = (item: string) => go({ section: 'uploads', item });
  const close = () => go({ section: 'uploads' });

  return (
    <>
      {!refused && (
        <div className="upload-bar">
          <div className="chips" role="group" aria-label={t('uploads.filterLabel')}>
            {[undefined, ...STATUSES].map((one) => (
              <button
                type="button"
                key={one ?? 'all'}
                className="chip"
                aria-pressed={status === one}
                onClick={() => setStatus(one)}
              >
                {one ? t(statusKey(one)) : t('uploads.filter.all')}{' '}
                <span className="muted">{list.value ? count(one) : ''}</span>
              </button>
            ))}
          </div>
          {mayPublish && count('accepted') > 0 && (
            <button type="button" disabled={publishing} onClick={publishAccepted}>
              {t('uploads.publishAll', { count: count('accepted') })}
            </button>
          )}
          {mayUpload && (
            <button type="button" className="primary" onClick={() => open(NEW)}>
              {t('uploads.new')}
            </button>
          )}
        </div>
      )}
      {published && <p className="hint">{published}</p>}
      {refused ? (
        <div className="upload-empty">
          <p>{isolate(unavailable(t, list.error, access.value))}</p>
          {signedOut && (
            <button type="button" className="primary" onClick={signIn}>
              {t('account.signIn')}
            </button>
          )}
        </div>
      ) : (
        list.error !== undefined && (
          <p className="error-text">{isolate(unavailable(t, list.error, access.value))}</p>
        )
      )}
      {!list.value && list.error === undefined && <p className="muted">{t('uploads.loading')}</p>}
      {list.value && shown.length === 0 && (
        <div className="upload-empty">
          <p className="muted">{all.length ? t('uploads.emptyFiltered') : t('uploads.empty')}</p>
          {!all.length && mayUpload && (
            <button type="button" onClick={() => open(NEW)}>
              {t('uploads.new')}
            </button>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <div className="lib-grid">
          {shown.map((upload) => (
            <UploadCard
              key={upload.id}
              upload={upload}
              files={files.value?.files}
              lang={lang}
              onOpen={() => open(upload.id)}
            />
          ))}
        </div>
      )}

      {route.item === NEW && (
        <NewUpload
          lang={lang}
          onClose={close}
          onCreated={(made) => {
            refresh();
            open(made.id);
          }}
        />
      )}
      {route.item && route.item !== NEW && (
        <UploadDetail
          key={route.item}
          id={route.item}
          lang={lang}
          access={access.value}
          onClose={close}
          onChanged={refresh}
          onGone={() => {
            refresh();
            close();
          }}
        />
      )}
    </>
  );
}
