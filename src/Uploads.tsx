import { CONTENT_LANGUAGES } from '@slidr/model';
import { useMemo, useState } from 'react';
import { isolate } from './bidi';
import { useLang, useT } from './i18n';
import { LanguageNames, type Lang } from './languages';
import { manifest, mediaUrl } from './media';
import { NewUpload } from './NewUpload';
import { matches, useRead, type LibraryRoute } from './shared';
import { UploadDetail } from './UploadDetail';
import {
  STATUSES,
  kindKey,
  readAccess,
  statusKey,
  unavailable,
  uploadsApi,
  when,
  who,
  type Status,
  type Summary,
} from './uploadsApi';

const NEW = 'new';

/** The picture that shows what an upload is: its own, the published design's, the template's. */
function pictureOf(upload: Summary, files: Record<string, unknown> | undefined) {
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

function UploadCard({
  upload,
  files,
  onOpen,
}: {
  upload: Summary;
  files?: Record<string, unknown>;
  onOpen: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const picture = pictureOf(upload, files);
  const adds = upload.action === 'add';
  return (
    <button type="button" className="lib-card upload-card" onClick={onOpen}>
      <span
        className={
          upload.type === 'designs' ? 'upload-card-picture checker' : 'upload-card-picture'
        }
      >
        {picture ? <img src={picture} alt="" loading="lazy" /> : null}
        <span className={`badge status-badge ${upload.status}`}>{t(statusKey(upload.status))}</span>
      </span>
      <span className="lib-card-body">
        <span className="lib-card-title" dir="ltr">
          {upload.target}
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
          {when(uiLang, upload.updated)}
          {upload.by !== 'anyone' && <> · {who(t, upload.by)}</>}
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
  const list = useRead(() => uploadsApi.list(), [version]);
  const access = useRead(readAccess, []);
  const files = useRead(manifest, []);
  const refresh = () => setVersion((at) => at + 1);

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
  const open = (item: string) => go({ section: 'uploads', item });
  const close = () => go({ section: 'uploads' });

  return (
    <>
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
        {mayUpload && (
          <button type="button" className="primary" onClick={() => open(NEW)}>
            {t('uploads.new')}
          </button>
        )}
      </div>
      {access.value?.signIn && !mayUpload && <p className="hint">{t('uploads.signIn')}</p>}

      {list.error !== undefined && (
        <p className="error-text">{isolate(unavailable(t, list.error))}</p>
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
