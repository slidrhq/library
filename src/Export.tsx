/**
 * Export (README, "Exporting and importing"): the library, or the parts of it chosen, in the
 * languages chosen, as one archive made in this browser from the files it reads
 * (`exportArchive.ts`), which another library brings in without a network. The languages are
 * chosen first, for the whole library; then each part, whole or by its groups where it has them
 * (`exportParts.ts`). The choice is kept in a cookie of this browser for the next time. The
 * archive is of the library as it is published when the export starts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { designsModule, messages, named } from './app';
import { isolate } from './bidi';
import {
  ExportFailed,
  archiveOf,
  cutCatalogs,
  manifestNow,
  pickFile,
  saveArchive,
  type Progress,
} from './exportArchive';
import {
  FRAMES_CATALOG,
  OTHER,
  REFERENCE_DECKS,
  bytesOf,
  chooseAll,
  chooseLanguage,
  choosePart,
  choosePiece,
  chosenOf,
  inLanguages,
  isChosen,
  languagesIn,
  languagesOf,
  partsOf,
  readSaved,
  save,
  stateOf,
  type Catalogs,
  type Chosen,
  type FontsCatalog,
  type Part,
  type Piece,
  type Saved,
} from './exportParts';
import { useLang, useT, type MessageKey, type Translate } from './i18n';
import { isBase, nativeName, type Lang } from './languages';
import { manifest, mediaJson, NotInLibrary, size, type Manifest } from './media';
import { sectionOf } from './sections';
import { useRead, type LibraryRoute } from './shared';

const FONTS = 'fonts/catalog.json';
const DESIGN_CATALOGS = ['elements/designs/index.json', 'elements/designs/managed.json'];

/** What each part with pieces says of them. */
const PIECES: Record<string, MessageKey> = {
  designs: 'export.pieces.designs',
  frames: 'export.pieces.frames',
  templates: 'export.pieces.templates',
};

/** Of the frames' catalog, its groups and the ids of their frames, and their stickers. */
interface FramesFile {
  groups?: { id?: unknown; frames?: { id?: unknown; extras?: { art?: unknown }[] }[] }[];
  stickers?: Record<string, unknown>;
}

/** How much of the frames' catalog a group is: its frames, and the stickers they put beside them. */
function weightOf(group: NonNullable<FramesFile['groups']>[number], file: FramesFile) {
  let weight = JSON.stringify(group).length;
  for (const frame of group.frames ?? []) {
    for (const { art } of frame.extras ?? []) {
      const sticker = typeof art === 'string' ? file.stickers?.[art] : undefined;
      if (typeof sticker === 'string') weight += sticker.length;
    }
  }
  return weight;
}

/** What the page reads of the catalogs, and the names of the designs' groups. */
interface Read extends Catalogs {
  designGroup: (group: string, lang: Lang) => string;
}

/**
 * The catalogs the pieces and the languages are known by: the designs as a gallery reads them
 * (every design is drawn in Hebrew and in English, so a reading in either has them all), the
 * frames' groups, and the letters each family of fonts is made for.
 */
async function readCatalogs(library: Manifest, base: Lang): Promise<Read> {
  const has = (path: string) => Object.hasOwn(library.files, path);
  const [fonts, designs, frames] = await Promise.all([
    has(FONTS) ? mediaJson<FontsCatalog>(FONTS).catch(() => undefined) : undefined,
    DESIGN_CATALOGS.some(has)
      ? designsModule().then((module) => module.loadDesigns(base))
      : undefined,
    has(FRAMES_CATALOG) ? mediaJson<FramesFile>(FRAMES_CATALOG).catch(() => undefined) : undefined,
  ]);
  const ids = (list: { id?: unknown }[] | undefined) =>
    (list ?? []).map(({ id }) => id).filter((id): id is string => typeof id === 'string');
  return {
    fonts,
    designs: designs?.groups
      .map((id) => ({ id, items: designs.designsOf(id) }))
      .filter(({ items }) => items.length > 0),
    frames: frames?.groups
      ?.filter((group) => typeof group.id === 'string')
      .map((group) => ({
        id: group.id as string,
        items: ids(group.frames),
        weight: weightOf(group, frames),
      }))
      .filter(({ items }) => items.length > 0),
    designGroup: (group, lang) =>
      named(messages.elements, lang, 'designs', 'group', group) ??
      designs?.designGroupName(group, lang) ??
      group,
  };
}

/** A checkbox of a whole and its parts: checked, unchecked, or some of it. */
function Check({
  state,
  disabled,
  onChange,
  label,
}: {
  state: 'all' | 'some' | 'none';
  disabled?: boolean;
  onChange: (on: boolean) => void;
  label?: string;
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
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

const sizeOfPaths = (read: Manifest, paths: Iterable<string>) => {
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
  | { at: 'running'; progress?: Progress; preparing?: boolean }
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
  const base: Lang = isBase(lang) ? lang : 'en';
  const catalogs = useRead(
    () => (library ? readCatalogs(library, base) : Promise.resolve(undefined)),
    [library, base],
  );
  const known = catalogs.value;
  const of = useMemo(() => languagesOf(known?.fonts), [known]);
  const parts = useMemo(() => (library && known ? partsOf(library, known) : []), [library, known]);
  const offered = useMemo(() => (library ? languagesIn(library, of) : []), [library, of]);
  const [saved, setSaved] = useState<Saved>(readSaved);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [run, setRun] = useState<Run>({ at: 'idle' });
  const stop = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stop.current?.abort(), []);

  const { chosen, languages } = saved;
  const choice = useMemo(
    () => chosenOf(parts, chosen, languages, of),
    [parts, chosen, languages, of],
  );
  const running = run.at === 'running';

  if (read.error !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: read.error }))}</p>;
  }
  if (catalogs.error !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: catalogs.error }))}</p>;
  }
  if (library === undefined || (library && !known)) {
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
  const choose = (next: Chosen) => keep({ ...saved, chosen: next });
  const files = (count: number) =>
    count === 1 ? t('library.fileOne') : t('library.fileMany', { count });
  const inChosen = (path: string) => inLanguages(languages, of(path));
  const languageOn = (one: string) => languages === '*' || languages.includes(one);
  const languagesOn = offered.filter(languageOn);
  const noLanguage = offered.length > 0 && languagesOn.length === 0;
  const whole = chosen === '*' && languages === '*';
  const allState = chosen === '*' ? 'all' : choice.paths.length === 0 ? 'none' : 'some';
  const total = bytesOf(library, choice);

  const nameOf = (part: Part) => {
    if (part.id === OTHER) return t('export.other');
    const section = sectionOf(part.id);
    return section ? t(section.nameKey) : part.id;
  };
  const aboutOf = (part: Part) => {
    if (part.id === OTHER) return t('export.otherAbout');
    const section = sectionOf(part.id);
    return section ? t(section.aboutKey) : '';
  };

  const pieceName = (part: Part, piece: Piece): ReactNode => {
    if (part.id === 'designs') return known!.designGroup(piece.id, lang);
    if (part.id === 'frames') {
      return named(messages.elements, lang, 'frames', 'group', piece.id) ?? piece.id;
    }
    if (part.id === 'templates') {
      return piece.id === REFERENCE_DECKS
        ? t('export.referenceDecks')
        : (named(messages.templates, lang, 'name', piece.id) ?? piece.id);
    }
    return <bdi dir="ltr">{piece.id}</bdi>;
  };

  /** How many items a piece is, where they are counted: designs, or frames. */
  const itemsOf = (part: Part, piece: Piece) => {
    const count = piece.items.length;
    if (part.id === 'designs') {
      return count === 1 ? t('export.designOne') : t('export.designs', { count });
    }
    if (part.id === 'frames') {
      return count === 1 ? t('export.frameOne') : t('export.frames', { count });
    }
    return undefined;
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

  /** The bytes of a part: of what is chosen of it, or of all of it in the languages chosen. */
  const bytesOfPart = (part: Part, wanted: Chosen) =>
    bytesOf(library, chosenOf([part], wanted, languages, of));

  const toggle = (part: Part) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(part.id)) next.delete(part.id);
      else next.add(part.id);
      return next;
    });

  const start = () => {
    const name = archiveName(library.published, whole, saved.gzip);
    const { gzip } = saved;
    const wanted = { chosen, languages };
    const groups = known;
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
        const nowParts = partsOf(now, groups ?? {});
        const all = chosenOf(nowParts, wanted.chosen, wanted.languages, languagesOf(groups?.fonts));
        if (all.cut.size > 0) setRun({ at: 'running', preparing: true });
        const written = await cutCatalogs(now, all, controller.signal);
        const archive = archiveOf(now, all.paths, {
          gzip,
          signal: controller.signal,
          written,
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
  const preparing = run.at === 'running' && run.preparing && !progress;
  const chosenParts = parts.filter((part) => stateOf(chosen, part) !== 'none');

  return (
    <div className="export">
      <div className="export-main">
        <section className="export-card" aria-labelledby="export-languages">
          <header className="export-head">
            <h3 id="export-languages">
              <span className="export-step" aria-hidden>
                1
              </span>
              {t('export.languages')}
            </h3>
            <label className="export-all-languages">
              <Check
                state={languages === '*' ? 'all' : noLanguage ? 'none' : 'some'}
                disabled={running}
                onChange={(on) => keep({ ...saved, languages: on ? '*' : [] })}
              />
              {t('export.allLanguages')}
              <span className="muted small">
                {t('export.languagesChosen', {
                  count: languagesOn.length.toLocaleString(uiLang),
                  of: offered.length.toLocaleString(uiLang),
                })}
              </span>
            </label>
          </header>
          <div className="export-body">
            <p className="muted small">{t('export.languagesAbout')}</p>
            <div className="export-langs" role="group" aria-labelledby="export-languages">
              {offered.map((one) => (
                <label key={one} className="export-lang">
                  <input
                    type="checkbox"
                    checked={languageOn(one)}
                    disabled={running}
                    onChange={(event) =>
                      keep({
                        ...saved,
                        languages: chooseLanguage(languages, offered, one, event.target.checked),
                      })
                    }
                  />
                  <bdi lang={one}>{nativeName(one)}</bdi>
                </label>
              ))}
            </div>
            {noLanguage && <p className="warn small">{t('export.noLanguage')}</p>}
          </div>
        </section>

        <section className="export-card" aria-labelledby="export-content">
          <header className="export-head">
            <h3 id="export-content">
              <span className="export-step" aria-hidden>
                2
              </span>
              {t('export.content')}
            </h3>
            <label className="export-everything">
              <Check state={allState} disabled={running} onChange={(on) => choose(chooseAll(on))} />
              {t('export.everything')}
              <span className="muted small export-size">
                {t('library.filesAndSize', {
                  files: files(Object.keys(library.files).length),
                  size: size(sizeOfPaths(library, Object.keys(library.files))),
                })}
              </span>
            </label>
          </header>
          <ul className="export-list">
            {parts.map((part) => {
              const state = stateOf(chosen, part);
              const expanded = open.has(part.id);
              const pieces = shownPieces(part);
              const chosenPieces = pieces.filter((piece) => isChosen(chosen, part, piece));
              const bytes = bytesOfPart(part, state === 'none' ? '*' : chosen);
              const count = chosenOf([part], state === 'none' ? '*' : chosen, languages, of).paths
                .length;
              const coreBytes = sizeOfPaths(library, part.core.filter(inChosen));
              return (
                <li key={part.id} className="export-part" data-state={state}>
                  <div className="export-row">
                    <label className="export-pick">
                      <Check
                        state={state}
                        disabled={running}
                        onChange={(on) => choose(choosePart(chosen, parts, part, on))}
                      />
                      <span className="export-label">
                        <span className="export-name">{nameOf(part)}</span>
                        <span className="export-about">{aboutOf(part)}</span>
                      </span>
                    </label>
                    {pieces.length > 0 && (
                      <button
                        type="button"
                        className="export-toggle"
                        aria-expanded={expanded}
                        onClick={() => toggle(part)}
                      >
                        {t(
                          part.id === 'templates'
                            ? 'export.templatesChosen'
                            : 'export.groupsChosen',
                          {
                            count: chosenPieces.length.toLocaleString(uiLang),
                            of: pieces.length.toLocaleString(uiLang),
                          },
                        )}
                        <span className="export-caret" aria-hidden />
                      </button>
                    )}
                    <span className="export-sizes">
                      <span className="export-size">{size(bytes)}</span>
                      <span className="muted small export-size">{files(count)}</span>
                    </span>
                  </div>
                  {expanded && (
                    <div className="export-pieces">
                      <div className="export-pieces-head">
                        <p className="muted small">
                          {PIECES[part.id] ? `${t(PIECES[part.id]!)} ` : ''}
                          {part.cut.length === 0 &&
                            coreBytes > 0 &&
                            t('export.with', { size: size(coreBytes) })}
                        </p>
                        <span className="export-pick-all">
                          <button
                            type="button"
                            className="link small"
                            disabled={running || state === 'all'}
                            onClick={() => choose(choosePart(chosen, parts, part, true))}
                          >
                            {t('export.pickAll')}
                          </button>
                          <button
                            type="button"
                            className="link small"
                            disabled={running || state === 'none'}
                            onClick={() => choose(choosePart(chosen, parts, part, false))}
                          >
                            {t('export.pickNone')}
                          </button>
                        </span>
                      </div>
                      <div className="export-piece-grid">
                        {pieces.map((piece) => {
                          const items = itemsOf(part, piece);
                          const pieceBytes = sizeOfPaths(library, piece.paths.filter(inChosen));
                          return (
                            <label key={piece.id} className="export-piece">
                              <input
                                type="checkbox"
                                checked={isChosen(chosen, part, piece)}
                                disabled={running}
                                onChange={(event) =>
                                  choose(
                                    choosePiece(chosen, parts, part, piece, event.target.checked),
                                  )
                                }
                              />
                              <span className="export-piece-text">
                                <span className="export-piece-name">{pieceName(part, piece)}</span>
                                <span className="export-piece-meta">
                                  {[items, pieceBytes > 0 && size(pieceBytes)]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <aside className="export-card export-bar" aria-labelledby="export-summary">
        <h3 id="export-summary">{t('export.summary')}</h3>
        {chosenParts.length > 0 ? (
          <ul className="export-chosen">
            {chosenParts.map((part) => (
              <li key={part.id}>
                <span>{nameOf(part)}</span>
                <span className="export-size">{size(bytesOfPart(part, chosen))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('export.none')}</p>
        )}
        {offered.length > 0 && (
          <p className="muted small">
            {languages === '*'
              ? t('export.allLanguages')
              : t('export.inLanguages', {
                  languages: languagesOn.map((one) => nativeName(one)).join(', ') || '—',
                })}
          </p>
        )}
        <p className="export-total">
          {choice.paths.length > 0
            ? t(choice.cut.size > 0 ? 'export.totalAbout' : 'export.total', {
                files: files(choice.paths.length),
                size: size(total),
              })
            : t('export.none')}
        </p>
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
          <button type="button" className="export-go" onClick={() => stop.current?.abort()}>
            {t('export.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="primary export-go"
            disabled={choice.paths.length === 0 || noLanguage}
            onClick={start}
          >
            {t('export.start')}
          </button>
        )}
        {running && (
          <div className="settings-progress">
            {progress ? <progress max={progress.ofBytes} value={progress.bytes} /> : <progress />}
            {preparing && <span className="small">{t('export.preparing')}</span>}
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
      </aside>
    </div>
  );
}
