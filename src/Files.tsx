import { useEffect, useMemo, useState } from 'react';
import { useT } from './i18n';
import { manifest, mediaText, mediaUrl, size, type Manifest } from './media';
import { useRead, type LibraryRoute } from './shared';

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: { name: string; path: string; size: number; sha256: string }[];
  count: number;
  bytes: number;
}

function tree(read: Manifest): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], count: 0, bytes: 0 };
  for (const [path, file] of Object.entries(read.files)) {
    const parts = path.split('/');
    let folder = root;
    folder.count += 1;
    folder.bytes += file.size;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = {
          name: part,
          path: folder.path ? `${folder.path}/${part}` : part,
          folders: new Map(),
          files: [],
          count: 0,
          bytes: 0,
        };
        folder.folders.set(part, next);
      }
      folder = next;
      folder.count += 1;
      folder.bytes += file.size;
    }
    folder.files.push({ name: parts.at(-1)!, path, ...file });
  }
  return root;
}

const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const IMAGES = new Set(['webp', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'avif']);
const TEXTS = new Set(['json', 'md', 'txt', 'css', 'js', 'csv']);
/** Text longer than this is shown in part: the whole file is a click away. */
const TEXT_LIMIT = 400_000;
/** JSON up to this size is laid out to be read; the largest catalogs are a few megabytes. */
const PRETTY_LIMIT = 12 * 1024 * 1024;

function FontSample({ path }: { path: string }) {
  const t = useT();
  const family = useMemo(() => `slidr-file-${path.replace(/\W/g, '-')}`, [path]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    const face = new FontFace(family, `url(${JSON.stringify(mediaUrl(path))})`);
    face.load().then(
      (loaded) => {
        document.fonts.add(loaded);
        setState('ready');
      },
      () => setState('failed'),
    );
  }, [family, path]);
  if (state === 'failed') return <p className="error-text">{t('library.files.fontFailed')}</p>;
  return (
    <div
      className="font-sample"
      style={{ fontFamily: family, opacity: state === 'ready' ? 1 : 0.3 }}
    >
      <p dir="rtl">אבגדהוזחטיכלמנסעפצקרשת 0123456789</p>
      <p dir="ltr">The quick brown fox jumps over the lazy dog</p>
    </div>
  );
}

function TextFile({ path, bytes }: { path: string; bytes: number }) {
  const t = useT();
  const text = useRead(() => mediaText(path), [path]);
  if (text.error) return <p className="error-text">{text.error}</p>;
  if (text.value === undefined) return <p className="muted">{t('library.loading')}</p>;
  let shown = text.value;
  if (extension(path) === 'json' && bytes <= PRETTY_LIMIT) {
    try {
      shown = JSON.stringify(JSON.parse(text.value), null, 2);
    } catch {
      // Not JSON after all: shown as it is.
    }
  }
  const cut = shown.length > TEXT_LIMIT;
  return (
    <>
      {cut && <p className="warn small">{t('library.files.cutOff', { size: size(bytes) })}</p>}
      <pre className="file-text" dir="ltr">
        {cut ? shown.slice(0, TEXT_LIMIT) : shown}
      </pre>
    </>
  );
}

/** One file of the library, as it is published. */
export function FilePreview({
  path,
  file,
}: {
  path: string;
  file?: { size: number; sha256: string };
}) {
  const t = useT();
  const kind = extension(path);
  return (
    <div className="file-preview">
      {IMAGES.has(kind) ? (
        <div className="file-image checker">
          <img src={mediaUrl(path)} alt={path} />
        </div>
      ) : kind === 'woff2' || kind === 'woff' || kind === 'ttf' ? (
        <FontSample path={path} />
      ) : kind === 'html' ? (
        <iframe
          className="file-frame"
          src={mediaUrl(path)}
          title={path}
          sandbox="allow-scripts"
          loading="lazy"
        />
      ) : TEXTS.has(kind) ? (
        <TextFile path={path} bytes={file?.size ?? 0} />
      ) : (
        <p className="muted">{t('library.files.noPreview')}</p>
      )}
    </div>
  );
}

export function FileFacts({
  path,
  file,
}: {
  path: string;
  file?: { size: number; sha256: string };
}) {
  return (
    <dl className="facts" dir="ltr">
      <dt>path</dt>
      <dd>{path}</dd>
      {file && (
        <>
          <dt>size</dt>
          <dd>{size(file.size)}</dd>
          <dt>sha256</dt>
          <dd className="hash">{file.sha256}</dd>
        </>
      )}
      <dt>url</dt>
      <dd>
        <a href={mediaUrl(path)} target="_blank" rel="noreferrer">
          {mediaUrl(path)}
        </a>
      </dd>
    </dl>
  );
}

/** Every file of the library, folder by folder, from its manifest. */
export function Files({
  route,
  go,
  query,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
}) {
  const t = useT();
  const read = useRead(manifest, []);
  const root = useMemo(() => (read.value ? tree(read.value) : undefined), [read.value]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!root || !read.value) return <p className="muted">{t('library.loading')}</p>;

  const files = read.value.files;
  const needle = query.trim().toLowerCase();
  if (needle) {
    const found = Object.keys(files).filter((path) => path.toLowerCase().includes(needle));
    return (
      <ul className="file-list" dir="ltr">
        {found.slice(0, 500).map((path) => (
          <li key={path}>
            <button type="button" className="file-row" onClick={() => go({ ...route, item: path })}>
              <span className="file-name">{path}</span>
              <span className="muted">{size(files[path]!.size)}</span>
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="muted">{t('library.files.noMatch')}</li>}
        {found.length > 500 && (
          <li className="muted">{t('library.files.andMore', { count: found.length - 500 })}</li>
        )}
      </ul>
    );
  }

  let folder = root;
  for (const part of (route.folder ?? '').split('/').filter(Boolean)) {
    const next = folder.folders.get(part);
    if (!next) break;
    folder = next;
  }
  const trail = folder.path ? folder.path.split('/') : [];

  return (
    <div className="files">
      <nav className="crumbs" dir="ltr" aria-label={t('library.files.folderLabel')}>
        <button type="button" className="link" onClick={() => go({ section: 'files' })}>
          /
        </button>
        {trail.map((part, i) => (
          <span key={i}>
            <button
              type="button"
              className="link"
              onClick={() => go({ section: 'files', folder: trail.slice(0, i + 1).join('/') })}
            >
              {part}
            </button>
            /
          </span>
        ))}
      </nav>
      <ul className="file-list" dir="ltr">
        {[...folder.folders.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((sub) => (
            <li key={sub.path}>
              <button
                type="button"
                className="file-row folder"
                onClick={() => go({ section: 'files', folder: sub.path })}
              >
                <span className="file-name">{sub.name}/</span>
                <span className="muted">
                  {t('library.filesAndSize', {
                    files: t('library.files.folderCount', { count: sub.count }),
                    size: size(sub.bytes),
                  })}
                </span>
              </button>
            </li>
          ))}
        {folder.files
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="file-row"
                onClick={() => go({ ...route, item: file.path })}
              >
                <span className="file-name">{file.name}</span>
                <span className="muted">{size(file.size)}</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
