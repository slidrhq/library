/**
 * The publications (docs/SPEC.md §9.5, §11), for those who review uploads: what each wrote into the
 * library, newest first. A publication of uploads names each upload it wrote, and those it did not
 * and why; an author's names the files it changed. Each opens to its files, and what became of the
 * cache before the library.
 */
import { useState } from 'react';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey } from './i18n';
import { useRead, type LibraryRoute } from './shared';
import {
  kindKey,
  readAccess,
  subjectOf,
  uploadsApi,
  when,
  who,
  type PublicationRecord,
} from './uploadsApi';

const REASONS: Record<NonNullable<PublicationRecord['skipped']>[number]['reason'], MessageKey> = {
  invalid: 'publications.reason.invalid',
  unwritable: 'publications.reason.unwritable',
  status: 'publications.reason.status',
  missing: 'publications.reason.missing',
};

/** A list of the library's files, by their paths. */
function Paths({ label, paths }: { label: string; paths?: string[] }) {
  if (!paths?.length) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <ul className="publication-paths">
          {paths.map((path) => (
            <li key={path}>
              <bdi dir="ltr">{path}</bdi>
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}

function Publication({
  record,
  go,
}: {
  record: PublicationRecord;
  go: (route: LibraryRoute) => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const uploads = record.uploads ?? [];
  const skipped = record.skipped ?? [];
  const counts = [
    record.kind === 'uploads' && t('publications.uploads', { count: uploads.length }),
    record.added.length > 0 && t('publications.added', { count: record.added.length }),
    record.changed.length > 0 && t('publications.changed', { count: record.changed.length }),
    (record.removed?.length ?? 0) > 0 &&
      t('publications.removed', { count: record.removed?.length ?? 0 }),
  ].filter(Boolean);
  const open = (id: string) => go({ section: 'uploads', item: id });
  return (
    <li className="publication">
      <details>
        <summary>
          <span className="publication-when">{when(uiLang, record.published)}</span>
          <span className="publication-kind">
            {t(
              record.kind === 'files'
                ? 'publications.kind.files'
                : record.kind === 'archive'
                  ? 'publications.kind.archive'
                  : 'publications.kind.uploads',
            )}
            {' · '}
            <bdi>{who(record.by.id)}</bdi>
          </span>
          <span className="muted small">{counts.join(' · ')}</span>
          {skipped.length > 0 && (
            <span className="warn small">
              {t('publications.skipped', { count: skipped.length })}
            </span>
          )}
        </summary>
        <div className="publication-body small">
          {uploads.length > 0 && (
            <ul className="publication-uploads">
              {uploads.map((one) => (
                <li key={one.id}>
                  <button type="button" className="link" onClick={() => open(one.id)}>
                    {t(kindKey(one))} · {subjectOf(t, one)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <ul className="publication-uploads">
              {skipped.map((one) => (
                <li key={one.id}>
                  <button type="button" className="link" onClick={() => open(one.id)}>
                    <bdi dir="ltr">{one.id}</bdi>
                  </button>{' '}
                  <span className="warn">{t(REASONS[one.reason])}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="facts">
            <Paths
              label={t('publications.added', { count: record.added.length })}
              paths={record.added}
            />
            <Paths
              label={t('publications.changed', { count: record.changed.length })}
              paths={record.changed}
            />
            <Paths
              label={t('publications.removed', { count: record.removed?.length ?? 0 })}
              paths={record.removed}
            />
          </dl>
          {record.cache && (
            <p className={record.cache.emptied === 'none' ? 'warn' : 'muted'}>
              {isolate(
                record.cache.emptied === 'none'
                  ? t('publications.cache.none', { message: record.cache.message ?? '' })
                  : t(
                      record.cache.emptied === 'host'
                        ? 'publications.cache.host'
                        : 'publications.cache.files',
                    ),
              )}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}

export function Publications({ go }: { go: (route: LibraryRoute) => void }) {
  const t = useT();
  const access = useRead(readAccess, []);
  const [pages, setPages] = useState<string[]>([]);
  const first = useRead(() => uploadsApi.publications(), []);
  const [more, setMore] = useState<PublicationRecord[]>([]);
  const [next, setNext] = useState<string>();
  const [failed, setFailed] = useState<string>();

  if (access.value && !access.value.mayReview) {
    return (
      <div className="upload-empty">
        <p>{t('publications.closed')}</p>
      </div>
    );
  }
  if (first.error !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: first.error }))}</p>;
  }
  if (!first.value) return <p className="muted">{t('publications.loading')}</p>;
  const all = [...first.value.publications, ...more];
  const after = pages.length > 0 ? next : first.value.next;
  const readMore = () => {
    if (!after) return;
    setFailed(undefined);
    uploadsApi.publications(after).then(
      (page) => {
        setMore((was) => [...was, ...page.publications]);
        setNext(page.next);
        setPages((was) => [...was, after]);
      },
      (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)),
    );
  };
  if (all.length === 0) {
    return (
      <div className="upload-empty">
        <p>{t('publications.none')}</p>
      </div>
    );
  }
  return (
    <div className="publications">
      <ul className="member-list">
        {all.map((record) => (
          <Publication key={record.published} record={record} go={go} />
        ))}
      </ul>
      {failed && <p className="error-text">{isolate(t('people.failed', { error: failed }))}</p>}
      {after && (
        <button type="button" className="ghost" onClick={readMore}>
          {t('publications.more')}
        </button>
      )}
    </div>
  );
}
