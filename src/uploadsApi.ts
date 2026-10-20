/**
 * The uploads to the library, as the page's server keeps them (`worker/uploads`, README
 * "Uploading"): the calls of its API, and the files a person brings to an upload, read in the
 * browser before they are sent.
 */
import { CONTENT_LANGUAGES, Slide, walkElements, type ContentLanguage } from '@slidr/model';
import type { MessageKey, Translate } from './i18n';

export type Status = 'pending' | 'accepted' | 'rejected' | 'published';
export const STATUSES: readonly Status[] = ['pending', 'accepted', 'rejected', 'published'];

/** What an upload does, as `<type>:<action>`. */
export type Kind = 'designs:add' | 'designs:translate' | 'templates:translate';
export const KINDS: readonly Kind[] = ['designs:add', 'designs:translate', 'templates:translate'];

export interface Issue {
  path: string;
  message: string;
  language?: ContentLanguage;
}

export interface Actor {
  id: string;
  name?: string;
}

export interface UploadFile {
  path: string;
  type: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  url: string;
}

export interface Upload {
  id: string;
  type: string;
  action: string;
  target: string;
  fields: { group?: string; subject?: [number, number] };
  languages: Partial<Record<ContentLanguage, LanguagePart>>;
  files: Record<string, UploadFile>;
  status: Status;
  note?: string;
  created: string;
  updated: string;
  by: Actor;
  history: { status: Status; at: string; by: Actor; note?: string }[];
  /** The languages it still needs before it is accepted. */
  missing: ContentLanguage[];
}

export interface Summary {
  id: string;
  type: string;
  action: string;
  target: string;
  status: Status;
  languages: ContentLanguage[];
  created: string;
  updated: string;
  by: string;
}

/** The content of one language: a design's slide (and its names), or a template's sample. */
export interface LanguagePart {
  slide?: Slide;
  sample?: unknown[];
  name?: string;
  groupName?: string;
}

export const kindOf = (upload: { type: string; action: string }) =>
  `${upload.type}:${upload.action}` as Kind;

// ---- In words

export const statusKey = (status: Status) => `uploads.status.${status}` as MessageKey;
export const kindKey = (upload: { type: string; action: string }) =>
  `uploads.kind.${kindOf(upload).replace(':', '.')}` as MessageKey;

/** Who did something: an editor by their address, a program by its name. */
export const who = (id: string) => (id.startsWith('key:') ? id.slice('key:'.length) : id);

/** A moment, as people read it in the language of the page. */
export const when = (lang: string, at: string) =>
  new Date(at).toLocaleString(lang, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** What the server answered instead of the uploads, in words. */
export function unavailable(t: Translate, error: unknown, access?: Access) {
  if (error instanceof ApiError && error.status === 401) {
    return access && !access.signIn ? t('uploads.noSignIn') : t('uploads.signIn');
  }
  if (error instanceof ApiError && error.code === 'not-an-editor') return t('uploads.notEditor');
  if (error instanceof ApiError && error.code === 'not-set-up') return t('uploads.notSetUp');
  if (error instanceof ApiError && (error.code === 'no-api' || error.status === 404)) {
    return t('uploads.noServer');
  }
  return t('uploads.unavailable', {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** An answer of the API that is not what was asked: its code, its words, and what to fix. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, init);
  } catch (error) {
    throw new ApiError(0, 'offline', error instanceof Error ? error.message : String(error));
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // The page's server without the API (a plain static server) answers with the page itself.
    throw new ApiError(response.status, 'no-api', `${response.status} ${response.statusText}`);
  }
  if (!response.ok) {
    const problem = body as { error?: string; message?: string; issues?: Issue[] };
    throw new ApiError(
      response.status,
      problem.error ?? 'failed',
      problem.message ?? `${response.status}`,
      problem.issues ?? [],
    );
  }
  return body as T;
}

/**
 * A read of the API that keeps what it answered when it failed (`useRead` keeps only its words),
 * so the page can say why: no one signed in, not an editor, no server.
 */
export type Settled<T> = { found: T; failed?: undefined } | { found?: undefined; failed: unknown };

export const settled = <T>(read: Promise<T>): Promise<Settled<T>> =>
  read.then(
    (found) => ({ found }),
    (failed: unknown) => ({ failed }),
  );

const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const uploadsApi = {
  list: (status?: Status) =>
    call<{ uploads: Summary[]; next?: string }>(
      `uploads?limit=200${status ? `&status=${status}` : ''}`,
    ),
  get: (id: string) => call<Upload>(`uploads/${id}`),
  /** A new upload: the upload as JSON, and its files by name. */
  create(body: object, files: Record<string, File | undefined>) {
    const form = new FormData();
    form.set('upload', new Blob([JSON.stringify(body)], { type: 'application/json' }));
    for (const [name, file] of Object.entries(files)) if (file) form.set(name, file, file.name);
    return call<Upload>('uploads', { method: 'POST', body: form });
  },
  putLanguage: (id: string, lang: ContentLanguage, part: LanguagePart) =>
    call<Upload>(`uploads/${id}/languages/${lang}`, sendJson('PUT', part)),
  deleteLanguage: (id: string, lang: ContentLanguage) =>
    call<Upload>(`uploads/${id}/languages/${lang}`, { method: 'DELETE' }),
  setStatus: (id: string, status: Status, note?: string) =>
    call<Upload>(`uploads/${id}/status`, sendJson('POST', note ? { status, note } : { status })),
  withdraw: (id: string) => call<undefined>(`uploads/${id}`, { method: 'DELETE' }),
};

/**
 * What the person may do here: the uploads are the library's editors', as signing in names them
 * (`/api/me`, worker/auth.ts). Where no one answers, or no one is signed in, nothing.
 */
export interface Access {
  /** Whether the server has signing in at all. */
  signIn: boolean;
  user?: { name: string; email: string; editor: boolean };
  mayUpload: boolean;
  mayReview: boolean;
}

export async function readAccess(): Promise<Access> {
  try {
    const me = await call<{ signIn?: boolean; user?: Access['user'] | null }>('me');
    const editor = Boolean(me.user?.editor);
    return {
      signIn: Boolean(me.signIn),
      user: me.user ?? undefined,
      mayUpload: editor,
      mayReview: editor,
    };
  } catch {
    return { signIn: false, mayUpload: false, mayReview: false };
  }
}

// ---- The files a person brings

/** The language a file is for, by its name: `he.json`, `slide.fr.json`, `zh-CN.json`. */
export function languageOfFile(name: string): ContentLanguage | undefined {
  const base = name.replace(/\.[^.]+$/, '');
  const codes = [...CONTENT_LANGUAGES].sort((a, b) => b.length - a.length);
  return codes.find((code) =>
    new RegExp(`(^|[^a-z])${code.replace('-', '\\-')}($|[^a-z])`, 'i').test(base),
  );
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a JSON file holds: a whole upload (as the API takes it), the content of one language (a
 * slide, `{ slide }`, a sample, `{ sample }`), or the content of several by their codes.
 */
export type Read =
  | { kind: 'upload'; upload: Record<string, unknown> }
  | { kind: 'languages'; parts: Partial<Record<ContentLanguage, LanguagePart>> }
  | { kind: 'part'; part: LanguagePart };

export function readContent(value: unknown): Read | undefined {
  if (Array.isArray(value)) return { kind: 'part', part: { sample: value as unknown[] } };
  if (!isRecord(value)) return undefined;
  if (typeof value.type === 'string' && isRecord(value.languages)) {
    return { kind: 'upload', upload: value };
  }
  if (Array.isArray(value.elements)) return { kind: 'part', part: { slide: value as Slide } };
  if (isRecord(value.slide) || Array.isArray(value.sample)) {
    return { kind: 'part', part: value };
  }
  const codes = Object.keys(value);
  if (
    codes.length > 0 &&
    codes.every((code) => (CONTENT_LANGUAGES as readonly string[]).includes(code))
  ) {
    const parts: Partial<Record<ContentLanguage, LanguagePart>> = {};
    for (const code of codes) {
      const read = readContent(value[code]);
      if (read?.kind === 'part') parts[code as ContentLanguage] = read.part;
    }
    return { kind: 'languages', parts };
  }
  return undefined;
}

/** Whether a slide is one the model takes; the first thing wrong with it when not. */
export function slideProblem(slide: unknown): string | undefined {
  const parsed = Slide.safeParse(slide);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  return issue ? `${issue.path.join('.') || 'slide'}: ${issue.message}` : 'not a slide';
}

/**
 * The point of the slide where its picture is: the middle of the first image that shows it, as a
 * first guess at the subject.
 */
export function pictureCentre(slide: Slide): [number, number] | undefined {
  for (const element of walkElements(slide.elements)) {
    if (element.type === 'image' && element.assetId === '__subject__') {
      const { x, y, w, h } = element.frame;
      return [Math.round(x + w / 2), Math.round(y + h / 2)];
    }
  }
  return undefined;
}

/** A picture the person chose: where the page shows it from, and its size. */
export interface Picture {
  file: File;
  url: string;
  width: number;
  height: number;
}

export async function readPicture(file: File): Promise<Picture> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return { file, url, width: image.naturalWidth, height: image.naturalHeight };
}

/** An id of the library from a name: `m-` and its words. */
export const idFromName = (name: string) =>
  'm-' +
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
