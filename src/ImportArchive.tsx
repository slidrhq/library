/**
 * Import from a file, in the settings of the library's admins (README, "Exporting and importing"):
 * an archive another library's Export wrote, brought into this one's media without a network
 * (`POST /api/library/archive`, server/core/media/archive.ts). The file is read here first: what
 * it would add, what of the library it would replace, and the catalogs it would merge into the
 * library's (`merged.ts`), is shown by part against the library as it is now, before anything is
 * sent. The library then writes it as a publication.
 */
import { useState, type ChangeEvent } from 'react';
import { isolate } from './bidi';
import { isMerged } from '../server/core/media/merged';
import { TarError, manifestOfArchive, sendArchive, type ArchiveImported } from './exportArchive';
import { OTHER, partsOf } from './exportParts';
import { useLang, useT, type Translate } from './i18n';
import { size, type Manifest } from './media';
import { sectionOf } from './sections';
import { when } from './uploadsApi';

/** The library's own manifest, as its server serves it now; none while its media is empty. */
async function ourManifest(): Promise<Manifest | null> {
  const response = await fetch('/media/manifest.json', { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`manifest.json: ${response.status}`);
  return (await response.json()) as Manifest;
}

/**
 * Of each part of an archive, how many of its files are new here, replace the library's, are
 * merged into the library's catalogs, or are the same.
 */
function compare(theirs: Manifest, ours: Manifest | null) {
  const rows = partsOf(theirs).map((part) => {
    const paths = [...part.core, ...part.pieces.flatMap((piece) => piece.paths)];
    let added = 0;
    let merged = 0;
    let same = 0;
    const replaced: string[] = [];
    for (const path of new Set(paths)) {
      const here = ours?.files[path];
      if (!here) added += 1;
      else if (here.sha256 === theirs.files[path]!.sha256) same += 1;
      else if (isMerged(path)) merged += 1;
      else replaced.push(path);
    }
    return { id: part.id, files: part.files, bytes: part.bytes, added, merged, same, replaced };
  });
  return {
    rows,
    replaced: rows.flatMap((row) => row.replaced).sort(),
    merged: rows.some((row) => row.merged > 0),
  };
}

type Step =
  | { at: 'idle' }
  | { at: 'reading' }
  | { at: 'ready'; file: File; theirs: Manifest; ours: Manifest | null }
  | { at: 'sending'; file: File; sent: number; total: number }
  | { at: 'done'; result: ArchiveImported }
  | { at: 'failed'; say: (t: Translate) => string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ImportPart({ kind }: { kind: 'folder' | 'r2' }) {
  const t = useT();
  const [uiLang] = useLang();
  const [step, setStep] = useState<Step>({ at: 'idle' });
  const files = (count: number) =>
    count === 1 ? t('library.fileOne') : t('library.fileMany', { count });

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setStep({ at: 'reading' });
    void (async () => {
      try {
        const [theirs, ours] = await Promise.all([manifestOfArchive(file), ourManifest()]);
        if (!theirs) setStep({ at: 'failed', say: (t) => t('import.noManifest') });
        else setStep({ at: 'ready', file, theirs, ours });
      } catch (error) {
        const said = messageOf(error);
        setStep({
          at: 'failed',
          say: (t) =>
            error instanceof TarError
              ? t('import.notArchive', { error: said })
              : t('people.failed', { error: said }),
        });
      }
    })();
  };

  const send = (file: File) => {
    setStep({ at: 'sending', file, sent: 0, total: file.size });
    sendArchive(file, (sent, total) => setStep({ at: 'sending', file, sent, total })).then(
      (result) => setStep({ at: 'done', result }),
      (error: unknown) => {
        const said = messageOf(error);
        setStep({ at: 'failed', say: (t) => t('people.failed', { error: said }) });
      },
    );
  };

  const busy = step.at === 'reading' || step.at === 'sending';
  const nameOf = (id: string) => {
    if (id === OTHER) return t('export.other');
    const section = sectionOf(id);
    return section ? t(section.nameKey) : id;
  };

  let body = null;
  if (step.at === 'reading') body = <p className="muted small">{t('import.reading')}</p>;
  if (step.at === 'failed') body = <p className="error-text small">{isolate(step.say(t))}</p>;
  if (step.at === 'ready') {
    const { theirs, ours, file } = step;
    const { rows, replaced, merged } = compare(theirs, ours);
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    const count = rows.reduce((sum, row) => sum + row.files, 0);
    const older =
      replaced.length > 0 &&
      ours?.published &&
      theirs.published &&
      Date.parse(theirs.published) < Date.parse(ours.published);
    body = (
      <>
        <p className="small">
          {t('import.from', {
            when: theirs.published ? when(uiLang, theirs.published) : '—',
            files: files(count),
            size: size(bytes),
          })}{' '}
          {ours
            ? ours.published && t('import.here', { when: when(uiLang, ours.published) })
            : t('import.hereEmpty')}
        </p>
        <table className="import-table small">
          <thead>
            <tr>
              <th>{t('import.part')}</th>
              <th>{t('import.new')}</th>
              <th>{t('import.replaced')}</th>
              <th>{t('import.merged')}</th>
              <th>{t('import.same')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{nameOf(row.id)}</td>
                <td>{row.added.toLocaleString(uiLang)}</td>
                <td className={row.replaced.length > 0 ? 'warn' : undefined}>
                  {row.replaced.length.toLocaleString(uiLang)}
                </td>
                <td>{row.merged.toLocaleString(uiLang)}</td>
                <td>{row.same.toLocaleString(uiLang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {merged && <p className="muted small">{t('import.mergedNote')}</p>}
        {older && <p className="warn small">{t('import.older')}</p>}
        {replaced.length > 0 && (
          <details>
            <summary className="small">
              {t('import.replacedList', { count: replaced.length.toLocaleString(uiLang) })}
            </summary>
            <ul className="publication-paths small">
              {replaced.map((path) => (
                <li key={path}>
                  <bdi dir="ltr">{path}</bdi>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="row">
          <button type="button" className="primary" onClick={() => send(file)}>
            {t('import.start')}
          </button>
          <button type="button" onClick={() => setStep({ at: 'idle' })}>
            {t('import.cancel')}
          </button>
        </div>
      </>
    );
  }
  if (step.at === 'sending') {
    const sent = step.sent >= step.total;
    body = (
      <div className="settings-progress">
        {sent ? <progress /> : <progress max={step.total} value={step.sent} />}
        <span className="small">
          {sent
            ? t('import.writing')
            : t('import.sending', { sent: size(step.sent), size: size(step.total) })}
        </span>
      </div>
    );
  }
  if (step.at === 'done') {
    const { result } = step;
    body = (
      <>
        <p className="ok small" role="status">
          {result.published
            ? t('import.done', {
                added: result.added.length.toLocaleString(uiLang),
                changed: result.changed.length.toLocaleString(uiLang),
                same: result.same.toLocaleString(uiLang),
              })
            : t('import.nothing')}
        </p>
        {result.published && (
          <div className="row">
            <button type="button" onClick={() => location.reload()}>
              {t('import.reload')}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="settings-part">
      <h3>{t('import.title')}</h3>
      <p className="small">
        {isolate(t('import.explain'))}{' '}
        {kind === 'folder' ? (
          <>
            {t('import.machine')} <code dir="ltr">sudo slidr-library import &lt;file&gt;</code>
          </>
        ) : (
          t('import.cloudflare')
        )}
      </p>
      {step.at !== 'ready' && (
        <div className="row">
          <label className="file-button" aria-disabled={busy}>
            <input
              type="file"
              accept=".tgz,.gz,.tar,application/gzip,application/x-tar"
              disabled={busy}
              onChange={choose}
            />
            {t('import.choose')}
          </label>
        </div>
      )}
      {body}
    </section>
  );
}
