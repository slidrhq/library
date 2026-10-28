/**
 * Export (README, "Exporting and importing"): the library, or the parts of it chosen, as one
 * archive made in this browser from the files it reads (`exportArchive.ts`), which another library
 * brings in without a network. Each part is chosen whole, or by its pieces where it has them
 * (`exportParts.ts`), and the choice is kept in a cookie of this browser for the next time. The
 * archive is of the library as it is published when the export starts.
 */
import { CONTENT_LANGUAGES } from '@slidr/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { messages, named } from './app';
import { isolate } from './bidi';
import {
  ExportFailed,
  archiveOf,
  manifestNow,
  pickFile,
  saveArchive,
  type Progress,
} from './exportArchive';
import {
  OTHER,
  REFERENCE_DECKS,
  chooseAll,
  choosePart,
  choosePiece,
  chosenPaths,
  isChosen,
  partsOf,
  readSaved,
  save,
  stateOf,
  type FontsCatalog,
  type Part,
  type Piece,
  type Saved,
} from './exportParts';
import { useLang, useT, type MessageKey, type Translate } from './i18n';
import { nativeName, type Lang } from './languages';
import { manifest, mediaJson, NotInLibrary, size, type Manifest } from './media';
import { sectionOf } from './sections';
import { useRead, type LibraryRoute } from './shared';

const FONTS = 'fonts/catalog.json';

/** What each part with pieces says of them. */
const PIECES: Record<string, MessageKey> = {
  designs: 'export.pieces.designs',
  templates: 'export.pieces.templates',
  fonts: 'export.pieces.fonts',
};

/** The letters a family is made for, by a name of the browser's in the language shown. */
const SCRIPT_NAMES: Record<string, { type: 'script' | 'language'; code: string }> = {
  he: { type: 'script', code: 'Hebr' },
  latin: { type: 'script', code: 'Latn' },
  arabic: { type: 'script', code: 'Arab' },
  cyrillic: { type: 'script', code: 'Cyrl' },
  devanagari: { type: 'script', code: 'Deva' },
  vietnamese: { type: 'language', code: 'vi' },
  japanese: { type: 'language', code: 'ja' },
  korean: { type: 'language', code: 'ko' },
  chinese: { type: 'language', code: 'zh' },
};

function scriptName(script: string, uiLang: string) {
  const known = SCRIPT_NAMES[script];
  if (!known) return script;
  try {
    return new Intl.DisplayNames([uiLang], { type: known.type }).of(known.code) ?? script;
  } catch {
    return script;
  }
}

const isLanguage = (id: string): id is Lang =>
  (CONTENT_LANGUAGES as readonly string[]).includes(id);

/** A checkbox of a whole and its parts: checked, unchecked, or some of it. */
function Check({
  state,
  disabled,
  onChange,
}: {
  state: 'all' | 'some' | 'none';
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={state === 'all'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

const bytesOf = (read: Manifest, paths: Iterable<string>) => {
  let bytes = 0;
  for (const path of paths) bytes += read.files[path]?.size ?? 0;
  return bytes;
};

/** The name of an archive: of the library published on a day, whole or part of it. */
const archiveName = (published: string | undefined, whole: boolean, gzip: boolean) =>
  `slidr-media-${(published || new Date().toISOString()).slice(0, 10)}${whole ? '' : '-part'}.${
    gzip ? 'tgz' : 'tar'
  }`;

/** How an export went, said in the language shown, whichever that is by then. */
type Run =
  | { at: 'idle' }
  | { at: 'running'; progress?: Progress }
  | { at: 'done'; name: string }
  | { at: 'stopped' }
  | { at: 'failed'; say: (t: Translate) => string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether this browser writes the archive to a file as it is made (Chrome, Edge). */
const writesAsMade = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

export function Export({
  lang,
  go,
  canImport,
}: {
  lang: Lang;
  go: (route: LibraryRoute) => void;
  /** Whether the one looking may bring an archive into this library (its admins). */
  canImport: boolean;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const read = useRead(
    () =>
      manifest().catch((error: unknown) => {
        if (error instanceof NotInLibrary) return null;
        throw error;
      }),
    [],
  );
  const library = read.value;
  const fonts = useRead(
    () =>
      library?.files[FONTS]
        ? mediaJson<FontsCatalog>(FONTS).catch(() => undefined)
        : Promise.resolve(undefined),
    [library],
  );
  const parts = useMemo(
    () => (library ? partsOf(library, fonts.value) : []),
    [library, fonts.value],
  );
  const [saved, setSaved] = useState<Saved>(readSaved);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [run, setRun] = useState<Run>({ at: 'idle' });
  const stop = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stop.current?.abort(), []);

  const chosen = saved.chosen;
  const paths = useMemo(() => chosenPaths(parts, chosen), [parts, chosen]);
  const running = run.at === 'running';

  if (read.error !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: read.error }))}</p>;
  }
  // The fonts are offered by their letters once their catalog is read.
  const fontsPending = Boolean(library?.files[FONTS]) && !('value' in fonts) && !fonts.error;
  if (library === undefined || fontsPending) {
    return <p className="muted">{t('library.loading')}</p>;
  }
  if (library === null || parts.length === 0) {
    return (
      <div className="upload-empty">
        <p>{t('export.empty')}</p>
      </div>
    );
  }

  const keep = (next: Saved) => {
    setSaved(next);
    save(next);
  };
  const choose = (next: typeof chosen) => keep({ ...saved, chosen: next });
  const files = (count: number) =>
    count === 1 ? t('library.fileOne') : t('library.fileMany', { count });
  const whole = chosen === '*';
  const allState = whole ? 'all' : paths.length === 0 ? 'none' : 'some';

  const nameOf = (part: Part) => {
    if (part.id === OTHER) return t('export.other');
    const section = sectionOf(part.id);
    return section ? t(section.nameKey) : part.id;
  };

  const pieceName = (part: Part, piece: Piece) => {
    if (part.id === 'designs' && isLanguage(piece.id)) {
      return <bdi lang={piece.id}>{nativeName(piece.id)}</bdi>;
    }
    if (part.id === 'templates') {
      return piece.id === REFERENCE_DECKS
        ? t('export.referenceDecks')
        : (named(messages.templates, lang, 'name', piece.id) ?? piece.id);
    }
    if (part.id === 'fonts') {
      const families = new Set(piece.paths.map((path) => path.split('/')[1])).size;
      return (
        <>
          {scriptName(piece.id, uiLang)}{' '}
          <span className="muted">
            · {families === 1 ? t('export.familyOne') : t('export.families', { count: families })}
          </span>
        </>
      );
    }
    return <bdi dir="ltr">{piece.id}</bdi>;
  };

  /** The pieces of a part in the order shown: the templates by their names, the decks last. */
  const shownPieces = (part: Part) =>
    part.id !== 'templates'
      ? part.pieces
      : [...part.pieces].sort((a, b) => {
          if (a.id === REFERENCE_DECKS || b.id === REFERENCE_DECKS) {
            return a.id === REFERENCE_DECKS ? 1 : -1;
          }
          const name = (piece: Piece) =>
            named(messages.templates, lang, 'name', piece.id) ?? piece.id;
          return name(a).localeCompare(name(b), uiLang);
        });

  const chosenOf = (part: Part) => {
    if (stateOf(chosen, part) === 'none') return 0;
    const held = new Set(part.core);
    for (const piece of part.pieces) {
      if (isChosen(chosen, part, piece)) for (const path of piece.paths) held.add(path);
    }
    return bytesOf(library, held);
  };

  const toggle = (part: Part) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(part.id)) next.delete(part.id);
      else next.add(part.id);
      return next;
    });

  const start = () => {
    const name = archiveName(library.published, whole, saved.gzip);
    const gzip = saved.gzip;
    const wanted = chosen;
    void (async () => {
      // Asked first, while the page still answers the click.
      const file = await pickFile(name, gzip, t('export.fileType'));
      if (file === null) return;
      const controller = new AbortController();
      stop.current = controller;
      setRun({ at: 'running' });
      let shown = 0;
      try {
        const now = await manifestNow();
        const all = chosenPaths(partsOf(now, fonts.value), wanted);
        const archive = archiveOf(now, all, {
          gzip,
          signal: controller.signal,
          onProgress: (progress) => {
            // A few times a second is enough to be seen.
            if (progress.files < progress.ofFiles && Date.now() - shown < 150) return;
            shown = Date.now();
            setRun({ at: 'running', progress });
          },
        });
        await saveArchive(archive, file, name, controller.signal);
        setRun({ at: 'done', name: file?.name ?? name });
      } catch (error) {
        if (controller.signal.aborted) setRun({ at: 'stopped' });
        else if (error instanceof ExportFailed && error.changed) {
          setRun({ at: 'failed', say: (t) => t('export.changed', { path: error.path }) });
        } else {
          setRun({ at: 'failed', say: (t) => t('people.failed', { error: messageOf(error) }) });
        }
      } finally {
        stop.current = undefined;
      }
    })();
  };

  const progress = run.at === 'running' ? run.progress : undefined;

  return (
    <div className="export">
      <section className="export-tree" aria-label={t('export.nav')}>
        <label className="export-row export-all">
          <Check state={allState} disabled={running} onChange={(on) => choose(chooseAll(on))} />
          <span className="export-name">{t('export.everything')}</span>
          <span className="muted small export-size">
            {t('library.filesAndSize', {
              files: files(Object.keys(library.files).length),
              size: size(bytesOf(library, Object.keys(library.files))),
            })}
          </span>
        </label>
        <ul>
          {parts.map((part) => {
            const state = stateOf(chosen, part);
            const expanded = open.has(part.id);
            const some = chosenOf(part);
            return (
              <li key={part.id} className="export-part">
                <div className="export-row">
                  {part.pieces.length > 0 ? (
                    <button
                      type="button"
                      className="ghost export-toggle"
                      aria-expanded={expanded}
                      aria-label={nameOf(part)}
                      onClick={() => toggle(part)}
                    >
                      <span aria-hidden>{expanded ? '▾' : '▸'}</span>
                    </button>
                  ) : (
                    <span className="export-toggle" />
                  )}
                  <label>
                    <Check
                      state={state}
                      disabled={running}
                      onChange={(on) => choose(choosePart(chosen, parts, part, on))}
                    />
                    <span className="export-name">{nameOf(part)}</span>
                  </label>
                  <span className="muted small export-size">
                    {state === 'some' && `${size(some)} / `}
                    {t('library.filesAndSize', {
                      files: files(part.files),
                      size: size(part.bytes),
                    })}
                  </span>
                </div>
                {part.id === OTHER && (
                  <p className="muted small export-note">{t('export.otherAbout')}</p>
                )}
                {expanded && (
                  <div className="export-pieces">
                    <p className="muted small">
                      {PIECES[part.id] ? `${t(PIECES[part.id]!)} ` : ''}
                      {part.core.length > 0 && t('export.with', { size: size(part.coreBytes) })}
                    </p>
                    <div className="export-piece-grid">
                      {shownPieces(part).map((piece) => (
                        <label key={piece.id} className="export-piece">
                          <input
                            type="checkbox"
                            checked={isChosen(chosen, part, piece)}
                            disabled={running}
                            onChange={(event) =>
                              choose(choosePiece(chosen, parts, part, piece, event.target.checked))
                            }
                          />
                          <span className="export-piece-name">{pieceName(part, piece)}</span>
                          <span className="muted small">{size(piece.bytes)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="export-bar">
        <p className="export-total">
          {paths.length > 0
            ? t('export.total', { files: files(paths.length), size: size(bytesOf(library, paths)) })
            : t('export.none')}
        </p>
        <div className="row">
          <label className="export-gzip">
            <input
              type="checkbox"
              checked={saved.gzip}
              disabled={running}
              onChange={(event) => keep({ ...saved, gzip: event.target.checked })}
            />
            {t('export.gzip')}
          </label>
          {running ? (
            <button type="button" onClick={() => stop.current?.abort()}>
              {t('export.stop')}
            </button>
          ) : (
            <button type="button" className="primary" disabled={paths.length === 0} onClick={start}>
              {t('export.start')}
            </button>
          )}
        </div>
        {running && (
          <div className="settings-progress">
            <progress max={progress?.ofBytes ?? 1} value={progress?.bytes ?? 0} />
            {progress && (
              <span className="small">
                {t('export.progress', {
                  files: progress.files.toLocaleString(uiLang),
                  of: progress.ofFiles.toLocaleString(uiLang),
                  size: size(progress.bytes),
                  ofSize: size(progress.ofBytes),
                })}
              </span>
            )}
          </div>
        )}
        {run.at === 'done' && (
          <p className="ok small" role="status">
            {isolate(t('export.done', { name: run.name }))}
          </p>
        )}
        {run.at === 'stopped' && <p className="small">{t('export.stopped')}</p>}
        {run.at === 'failed' && <p className="error-text small">{isolate(run.say(t))}</p>}
        <p className="muted small">
          {t('export.kept')} {!writesAsMade && t('export.inMemory')}
        </p>
        {canImport && (
          <button type="button" className="link small" onClick={() => go({ section: 'settings' })}>
            {t('export.importHint')}
          </button>
        )}
      </section>
    </div>
  );
}
