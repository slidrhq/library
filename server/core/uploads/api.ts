/**
 * The REST API of uploads to the library (README, "Uploading"), under `/api/`:
 *
 *   GET    /api/content                          the parts of the library, its languages, what each takes
 *   GET    /api/openapi.json                     this API, as OpenAPI 3.1
 *   GET    /api/schemas/{slide,sample}.json      the JSON Schema of a slide, of a template's sample
 *   GET    /api/uploads                          the uploads, newest first (?type ?action ?status ?target ?language)
 *   POST   /api/uploads                          a new upload: JSON, or a form with its files
 *   GET    /api/uploads/{id}                     one upload, all it holds
 *   DELETE /api/uploads/{id}                     withdraws it, while it waits or once rejected
 *   GET    /api/uploads/{id}/files/{name}        one of its files
 *   PUT    /api/uploads/{id}/languages/{lang}    writes it in a language, or again in one
 *   DELETE /api/uploads/{id}/languages/{lang}    takes a language it may do without away
 *   POST   /api/uploads/{id}/status              accepts it, rejects it, sends it back, or says it is published
 *   GET    /api/library                          where the published library is, and what waits for it
 *   POST   /api/library/import                   brings the site's library into its bucket, once
 *   POST   /api/publish                          writes the accepted uploads into the library
 *   PUT    /api/library/staged/{sha256}          a file of an author's publication, by its hash
 *   POST   /api/library/files                    an author's publication: the files changed since a pull
 *   POST   /api/library/archive                  brings an archive of the library in: a .tar or .tgz
 *
 * Every route of the uploads asks `access.ts` first: they are the library's editors'. What
 * describes the API is open to anyone. Only a publication changes the published library
 * (`../media/publish.ts`): it writes the accepted uploads into the library's bucket.
 */
import {
  CONTENT_LANGUAGES,
  slideJsonSchema,
  toJsonSchema,
  type ContentLanguage,
} from '@slidr/model';
import type { Bucket } from '../bucket.ts';
import type { Context } from '../context.ts';
import { isRecord, json, jsonBody, problem, type Issue } from '../http.ts';
import { authorize, limited, recordOf, seesAll, type Actor, type Permission } from './access.ts';
import { limitsOf, waitingOf } from '../limits.ts';
import { describeContent, handlerOf, partOf, PARTS } from './content.ts';
import { sha256, sniff, webpSize } from './files.ts';
import type { Draft, Handler, StoredFile } from './handler.ts';
import {
  archiveRoute,
  filesRoute,
  importRoute,
  isLive,
  libraryStatus,
  MOMENT,
  publicationRoute,
  publicationsRoute,
  publishRoute,
  stageRoute,
} from '../media/routes.ts';
import { publishNow } from '../media/settle.ts';
import { LibraryUnreachable, libraryFor, type Library } from './library.ts';
import { openApi } from './openapi.ts';
import {
  STATUSES,
  createUpload,
  isUploadId,
  listUploads,
  newUploadId,
  readFile,
  readUpload,
  removeUpload,
  saveUpload,
  type Status,
  type Upload,
} from './store.ts';
import { Sample } from './templates.ts';

/** The largest request: a design's files and its slide in every language. */
const REQUEST_BYTES = 64 * 1024 * 1024;
const NOTE_MOST = 1000;

type Route = (request: Request, ctx: Context, params: string[]) => Promise<Response>;

const isLanguage = (code: string): code is ContentLanguage =>
  (CONTENT_LANGUAGES as readonly string[]).includes(code);

/** An upload's languages in the order of the app's, Hebrew and English first, as catalogs hold them. */
const ordered = (languages: Draft['languages']): Draft['languages'] =>
  Object.fromEntries(
    CONTENT_LANGUAGES.filter((lang) => Object.hasOwn(languages, lang)).map((lang) => [
      lang,
      languages[lang],
    ]),
  );

/** The languages an upload still has to be written in before it is accepted. */
const missingOf = (handler: Handler, upload: Draft) =>
  handler.languages.complete.filter((lang) => !Object.hasOwn(upload.languages, lang));

/**
 * An upload as the API answers it: with the languages it lacks, and where to read its files. Where
 * the library will keep them is the library's own business (D7), and no answer says it.
 */
function view(upload: Upload) {
  const handler = handlerOf(upload.type, upload.action);
  const base = `/api/uploads/${upload.id}`;
  return {
    ...upload,
    missing: handler ? missingOf(handler, upload) : [],
    files: Object.fromEntries(
      Object.entries(upload.files).map(([name, { path: _kept, ...file }]) => [
        name,
        { ...file, url: `${base}/files/${name}` },
      ]),
    ),
  };
}

const notSetUp = () =>
  problem(503, 'not-set-up', 'This server keeps no uploads: it has no bucket for them (UPLOADS).');

const libraryOf = (ctx: Context): Library => libraryFor(ctx);

/** The checks of a handler, or the answer to give when the library cannot be read. */
async function checked(
  handler: Handler,
  draft: Draft,
  ctx: Context,
  only?: readonly ContentLanguage[],
): Promise<Issue[] | Response> {
  try {
    return await handler.check(draft, libraryOf(ctx), only);
  } catch (error) {
    if (!(error instanceof LibraryUnreachable)) throw error;
    console.warn(error.message);
    return problem(
      503,
      'library-unreachable',
      'The published library could not be read to check the upload against it. Try again.',
    );
  }
}

/**
 * The other uploads of the same new item, or of the tags of the same part, that wait or were
 * accepted: a part's tags are one upload at a time, written in it until it is published.
 */
async function rivals(bucket: Bucket, draft: Draft, self?: string): Promise<Issue[]> {
  if (draft.action !== 'add' && draft.action !== 'tag') return [];
  const { uploads } = await listUploads(
    bucket,
    { type: draft.type, action: draft.action, target: draft.target },
    1000,
  );
  const does = draft.action === 'add' ? 'adds' : 'tags';
  return uploads
    .filter(
      (other) => other.id !== self && (other.status === 'pending' || other.status === 'accepted'),
    )
    .map((other) => ({
      path: 'id',
      message: `The upload ${other.id} ${does} ${draft.target} too.`,
    }));
}

const invalid = (issues: Issue[]) => problem(422, 'invalid', 'The upload does not hold.', issues);

/**
 * Reads the upload of a route, or the answer to give instead. An uploader sees their own uploads
 * only: another's is not there, as far as they can tell.
 */
async function load(ctx: Context, id: string | undefined, actor: Actor) {
  if (!ctx.state) return notSetUp();
  const found = id ? await readUpload(ctx.state, id) : undefined;
  if (!found || !(seesAll(actor) || found.upload.by.id === actor.id)) {
    return problem(404, 'not-found', `There is no upload ${id}.`);
  }
  return { bucket: ctx.state, ...found };
}

const now = () => new Date().toISOString();

// ---- GET /api/content, /api/openapi.json, /api/schemas/…

const content: Route = () => Promise.resolve(json(describeContent()));

const openapi: Route = () => Promise.resolve(json(openApi()));

let schemas: Record<string, unknown> | undefined;

const schema: Route = (_request, _ctx, [name]) => {
  schemas ??= { slide: slideJsonSchema(), sample: toJsonSchema(Sample) };
  const found = name ? schemas[name] : undefined;
  return Promise.resolve(
    found ? json(found) : problem(404, 'not-found', `There is no schema ${name}.`),
  );
};

// ---- GET /api/uploads

const list: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'read-own');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return problem(400, 'bad-query', 'limit is a whole number from 1 to 200.');
  }
  const filter = {
    type: query.get('type') ?? undefined,
    action: query.get('action') ?? undefined,
    status: query.get('status') ?? undefined,
    target: query.get('target') ?? undefined,
    language: query.get('language') ?? undefined,
    // An uploader lists their own.
    by: seesAll(actor) ? undefined : actor.id,
  };
  if (filter.status && !(STATUSES as readonly string[]).includes(filter.status)) {
    return problem(400, 'bad-query', `status is one of ${STATUSES.join(', ')}.`);
  }
  if (filter.language && !isLanguage(filter.language)) {
    return problem(400, 'bad-query', `language is one of ${CONTENT_LANGUAGES.join(', ')}.`);
  }
  const found = await listUploads(ctx.state, filter, limit, query.get('after') ?? undefined);
  return json(found);
};

// ---- POST /api/uploads

interface Received {
  body: unknown;
  files: Map<string, File>;
}

/** The upload's description and its files, from a form or from JSON. */
async function receive(request: Request): Promise<Received | Response> {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > REQUEST_BYTES) {
    return problem(413, 'too-large', `An upload is at most ${REQUEST_BYTES / 1024 / 1024} MiB.`);
  }
  const type = request.headers.get('Content-Type') ?? '';
  if (/^multipart\/form-data\b/i.test(type)) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return problem(400, 'bad-form', 'The form could not be read.');
    }
    const part = form.get('upload');
    if (part === null) {
      return problem(400, 'bad-form', 'The form has no part `upload`: the upload, as JSON.');
    }
    let body: unknown;
    try {
      body = JSON.parse(typeof part === 'string' ? part : await part.text());
    } catch {
      return problem(400, 'bad-json', 'The part `upload` is not JSON.');
    }
    const files = new Map<string, File>();
    for (const [name, value] of form) {
      if (name === 'upload') continue;
      if (typeof value === 'string' || files.has(name)) {
        return problem(400, 'bad-form', `The part ${name} is not a file, or is sent twice.`);
      }
      files.set(name, value);
    }
    return { body, files };
  }
  const body = await jsonBody(request);
  return body instanceof Response ? body : { body, files: new Map() };
}

/** The languages of an upload: each one the app has, and the handler takes. */
function readLanguages(handler: Handler, value: unknown, issues: Issue[]) {
  if (!isRecord(value)) {
    issues.push({
      path: 'languages',
      message: 'The content in each language, by its code: { "he": …, "en": … }.',
    });
    return {};
  }
  for (const code of Object.keys(value)) {
    if (!isLanguage(code)) {
      issues.push({
        path: `languages.${code}`,
        message: `${code} is no language of the app; they are ${CONTENT_LANGUAGES.join(', ')}.`,
      });
    } else if (!handler.languages.allowed.includes(code)) {
      issues.push({
        path: `languages.${code}`,
        message: `${handler.type} are not written in ${code} here; they take ${handler.languages.allowed.join(', ')}.`,
        language: code,
      });
    }
  }
  for (const lang of handler.languages.required.filter((one) => !Object.hasOwn(value, one))) {
    issues.push({
      path: `languages.${lang}`,
      message: `${handler.type} are uploaded in ${handler.languages.required.join(' and ')}.`,
      language: lang,
    });
  }
  if (Object.keys(value).length === 0) {
    issues.push({ path: 'languages', message: 'An upload is written in one language at least.' });
  }
  return ordered(value);
}

/** The files an upload brings, checked and described as they are kept. */
async function readFiles(
  handler: Handler,
  target: string,
  files: Map<string, File>,
  issues: Issue[],
) {
  const stored: Record<string, StoredFile> = {};
  const bytes = new Map<string, Uint8Array>();
  for (const rule of handler.files) {
    if (rule.required && !files.has(rule.name)) {
      issues.push({
        path: `files.${rule.name}`,
        message: `The upload brings ${rule.name}: ${rule.about}`,
      });
    }
  }
  for (const [name, file] of files) {
    const rule = handler.files.find((one) => one.name === name);
    if (!rule) {
      const takes = handler.files.map((one) => one.name).join(', ') || 'none';
      issues.push({
        path: `files.${name}`,
        message: `An upload of this kind brings no file ${name}; it takes ${takes}.`,
      });
      continue;
    }
    if (file.size > rule.maxBytes) {
      issues.push({
        path: `files.${name}`,
        message: `${name} is at most ${rule.maxBytes / 1024 / 1024} MiB.`,
      });
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const type = sniff(data);
    if (!type || !rule.types.includes(type)) {
      issues.push({ path: `files.${name}`, message: `${name} is ${rule.types.join(' or ')}.` });
      continue;
    }
    const size = type === 'image/webp' ? webpSize(data) : undefined;
    if (type === 'image/webp' && !size) {
      issues.push({
        path: `files.${name}`,
        message: `${name} is not a WebP picture that can be read.`,
      });
      continue;
    }
    stored[name] = {
      path: rule.path(target),
      type,
      bytes: data.length,
      sha256: await sha256(data),
      ...(size ? { width: size[0], height: size[1] } : {}),
    };
    bytes.set(name, data);
  }
  return { stored, bytes };
}

const create: Route = async (request, ctx) => {
  const actor = await authorize(request, ctx, 'upload');
  if (actor instanceof Response) return actor;
  if (!ctx.state) return notSetUp();
  // Anyone without a role keeps only so much waiting (`../limits.ts`).
  const limits = limited(actor) ? await limitsOf(ctx) : undefined;
  const waiting = limits ? await waitingOf(ctx, actor.id) : undefined;
  if (limits && waiting && waiting.count >= limits.pending) {
    return problem(
      409,
      'limit',
      `You have ${waiting.count} uploads waiting, the most one person keeps: withdraw one, or wait for a review.`,
    );
  }
  const received = await receive(request);
  if (received instanceof Response) return received;
  const { body, files } = received;
  if (!isRecord(body)) return invalid([{ path: '', message: 'An upload is a JSON object.' }]);

  const { type, action, id, languages, ...rest } = body;
  const part = typeof type === 'string' ? partOf(type) : undefined;
  if (!part) {
    return invalid([
      {
        path: 'type',
        message: `The parts of the library are ${PARTS.map((one) => one.type).join(', ')}.`,
      },
    ]);
  }
  if (part.handlers.length === 0)
    return problem(
      422,
      'not-uploadable',
      `The library takes no uploads of ${part.type}. ${part.closed ?? ''}`.trim(),
    );
  const handler = typeof action === 'string' ? handlerOf(part.type, action) : undefined;
  if (!handler) {
    const actions = part.handlers.map((one) => one.action).join(', ');
    // A part that takes no new items says why, when that is what was asked.
    const why = action === 'add' && part.closed ? ` ${part.closed}` : '';
    return invalid([
      { path: 'action', message: `An upload of ${part.type} does one of: ${actions}.${why}` },
    ]);
  }
  const issues: Issue[] = [];
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ path: 'id', message: handler.id });
  }
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    if (handler.fields.some((field) => field.name === name)) fields[name] = value;
    else issues.push({ path: name, message: `An upload of this kind has no field ${name}.` });
  }
  for (const field of handler.fields.filter((one) => one.required && !(one.name in fields))) {
    issues.push({ path: field.name, message: field.about });
  }
  const written = readLanguages(handler, languages, issues);
  const target = typeof id === 'string' ? id : '';
  const { stored, bytes } = await readFiles(handler, target, files, issues);
  if (issues.length > 0) return invalid(issues);
  const size = [...bytes.values()].reduce((sum, file) => sum + file.length, 0);
  if (limits && waiting && waiting.bytes + size > limits.bytes) {
    return problem(
      409,
      'limit',
      `Your uploads waiting would hold more than ${limits.bytes / 1024 / 1024} MiB of files, the most one person keeps.`,
    );
  }

  const draft: Draft = {
    type: part.type,
    action: handler.action,
    target,
    fields,
    languages: written,
    files: stored,
  };
  const found = await checked(handler, draft, ctx);
  if (found instanceof Response) return found;
  found.push(...(await rivals(ctx.state, draft)));
  if (found.length > 0) return invalid(found);

  const at = now();
  // A program that publishes (a `publish` token, an admin's) has its upload accepted as it comes,
  // when it is written in every language it needs, and published at once, as an approval is.
  const publishes =
    actor.via === 'token' && actor.scope === 'publish' && missingOf(handler, draft).length === 0;
  const upload: Upload = {
    id: newUploadId(),
    ...draft,
    status: publishes ? 'accepted' : 'pending',
    created: at,
    updated: at,
    by: recordOf(actor),
    history: [
      { status: 'pending', at, by: recordOf(actor) },
      ...(publishes ? [{ status: 'accepted' as const, at, by: recordOf(actor) }] : []),
    ],
  };
  await createUpload(ctx.state, upload, bytes);
  const location = { Location: `/api/uploads/${upload.id}` };
  if (publishes && (await isLive(ctx))) {
    const publishing = await publishNow(ctx, actor, [upload.id]);
    const after = (await readUpload(ctx.state, upload.id))?.upload ?? upload;
    return json({ ...view(after), publishing }, 201, location);
  }
  return json(view(upload), 201, location);
};

// ---- GET, DELETE /api/uploads/{id}

const read: Route = async (request, ctx, [id]) => {
  const actor = await authorize(request, ctx, 'read-own');
  if (actor instanceof Response) return actor;
  const found = await load(ctx, id, actor);
  if (found instanceof Response) return found;
  return json(view(found.upload));
};

const withdraw: Route = async (request, ctx, [id]) => {
  const actor = await authorize(request, ctx, 'upload');
  if (actor instanceof Response) return actor;
  const found = await load(ctx, id, actor);
  if (found instanceof Response) return found;
  const { status } = found.upload;
  if (status !== 'pending' && status !== 'rejected') {
    return problem(
      409,
      'not-withdrawable',
      `The upload is ${status}: only one that waits, or was rejected, is withdrawn.`,
    );
  }
  await removeUpload(found.bucket, found.upload);
  return new Response(null, { status: 204 });
};

// ---- GET /api/uploads/{id}/files/{name}

const file: Route = async (request, ctx, [id, name]) => {
  const actor = await authorize(request, ctx, 'read-own');
  if (actor instanceof Response) return actor;
  const found = await load(ctx, id, actor);
  if (found instanceof Response) return found;
  const stored = name ? found.upload.files[name] : undefined;
  const object = stored && name ? await readFile(found.bucket, found.upload.id, name) : null;
  if (!stored || !object) return problem(404, 'not-found', `The upload has no file ${name}.`);
  return new Response(object.body, {
    headers: {
      'Content-Type': stored.type,
      'Content-Length': String(object.size),
      ETag: `"${stored.sha256}"`,
      'Cache-Control': 'no-store',
    },
  });
};

// ---- PUT, DELETE /api/uploads/{id}/languages/{lang}

/**
 * Changes an upload that waits, and checks it as it would be: the whole of it, against the
 * published library as it is now.
 */
async function change(
  ctx: Context,
  actor: Actor,
  id: string | undefined,
  lang: string | undefined,
  edit: (upload: Upload, handler: Handler, lang: ContentLanguage) => Issue[] | Response,
  /** The languages the change asks to check again. */
  recheck: (lang: ContentLanguage) => ContentLanguage[],
): Promise<Response> {
  const found = await load(ctx, id, actor);
  if (found instanceof Response) return found;
  const { bucket, upload, etag } = found;
  const handler = handlerOf(upload.type, upload.action);
  if (!handler)
    return problem(409, 'not-uploadable', `The library no longer takes ${upload.type}.`);
  if (!lang || !isLanguage(lang)) {
    return problem(
      404,
      'not-found',
      `${lang} is no language of the app; they are ${CONTENT_LANGUAGES.join(', ')}.`,
    );
  }
  if (upload.status !== 'pending') {
    return problem(
      409,
      'not-pending',
      `The upload is ${upload.status}: only one that waits is changed.`,
    );
  }
  const edited = edit(upload, handler, lang);
  if (edited instanceof Response) return edited;
  if (edited.length > 0) return invalid(edited);
  const issues = await checked(handler, upload, ctx, recheck(lang));
  if (issues instanceof Response) return issues;
  if (issues.length > 0) return invalid(issues);
  upload.updated = now();
  if (!(await saveUpload(bucket, upload, etag))) {
    return problem(
      409,
      'changed-meanwhile',
      'The upload was changed while this was written. Try again.',
    );
  }
  return json(view(upload));
}

const putLanguage: Route = async (request, ctx, [id, lang]) => {
  const actor = await authorize(request, ctx, 'upload');
  if (actor instanceof Response) return actor;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  return change(
    ctx,
    actor,
    id,
    lang,
    (upload, handler, code) => {
      if (!handler.languages.allowed.includes(code)) {
        return [
          {
            path: `languages.${code}`,
            message: `${handler.type} are not written in ${code} here; they take ${handler.languages.allowed.join(', ')}.`,
            language: code,
          },
        ];
      }
      upload.languages = ordered({ ...upload.languages, [code]: body });
      return [];
    },
    (code) => [code],
  );
};

const deleteLanguage: Route = async (request, ctx, [id, lang]) => {
  const actor = await authorize(request, ctx, 'upload');
  if (actor instanceof Response) return actor;
  return change(
    ctx,
    actor,
    id,
    lang,
    (upload, handler, code) => {
      if (!Object.hasOwn(upload.languages, code)) {
        return problem(404, 'not-found', `The upload is not written in ${code}.`);
      }
      if (handler.languages.required.includes(code)) {
        return problem(
          409,
          'required',
          `${handler.type} are uploaded in ${handler.languages.required.join(' and ')}: ${code} stays.`,
        );
      }
      if (Object.keys(upload.languages).length === 1) {
        return problem(
          409,
          'required',
          'An upload is written in one language at least: withdraw it instead.',
        );
      }
      const { [code]: _gone, ...rest } = upload.languages;
      upload.languages = rest;
      return [];
    },
    () => [],
  );
};

// ---- POST /api/uploads/{id}/status

/** The statuses an upload goes to from each, and what it takes to send it there. */
const MOVES: Record<Status, Partial<Record<Status, Permission>>> = {
  pending: { accepted: 'review', rejected: 'review' },
  accepted: { pending: 'review', rejected: 'review', published: 'publish-waiting' },
  rejected: { pending: 'review' },
  // An upload marked published that the library does not have after all goes back to wait for
  // a publication, by whoever may say it is published.
  published: { accepted: 'publish-waiting' },
};

const setStatus: Route = async (request, ctx, [id]) => {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const to = isRecord(body) ? body.status : undefined;
  const note = isRecord(body) ? body.note : undefined;
  if (typeof to !== 'string' || !(STATUSES as readonly string[]).includes(to)) {
    return invalid([{ path: 'status', message: `The status is one of ${STATUSES.join(', ')}.` }]);
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_MOST)) {
    return invalid([
      { path: 'note', message: `A note is a text of up to ${NOTE_MOST} characters.` },
    ]);
  }
  const status = to as Status;
  // Every move is a reviewer's, or a program's that publishes: one who sees every upload.
  const reader = await authorize(request, ctx, 'read-all');
  if (reader instanceof Response) return reader;
  const found = await load(ctx, id, reader);
  if (found instanceof Response) return found;
  const { bucket, upload, etag } = found;
  const permission = MOVES[upload.status][status];
  if (!permission) {
    return problem(409, 'not-allowed', `An upload that is ${upload.status} is not made ${status}.`);
  }
  const actor: Actor | Response = await authorize(request, ctx, permission);
  if (actor instanceof Response) return actor;
  // Once the library is in its bucket, an upload is published by publishing it, not by saying so.
  if (status === 'published' && (await isLive(ctx))) {
    return problem(
      409,
      'publish-instead',
      'The library is published through the uploads now: publish it (POST /api/publish).',
    );
  }

  if (status === 'accepted') {
    // Accepted as the library is now, and only when it is written in every language it needs.
    const handler = handlerOf(upload.type, upload.action);
    if (!handler)
      return problem(409, 'not-uploadable', `The library no longer takes ${upload.type}.`);
    const missing = missingOf(handler, upload);
    if (missing.length > 0) {
      return problem(409, 'incomplete', `The upload is not yet written in ${missing.join(', ')}.`);
    }
    const issues = await checked(handler, upload, ctx);
    if (issues instanceof Response) return issues;
    issues.push(...(await rivals(bucket, upload, upload.id)));
    if (issues.length > 0) return invalid(issues);
  }

  const at = now();
  upload.status = status;
  upload.updated = at;
  // Why it waited to be written is told again by the next approval, if any.
  delete upload.publication;
  if (note === undefined) delete upload.note;
  else upload.note = note;
  upload.history.push({
    status,
    at,
    by: recordOf(actor),
    ...(note === undefined ? {} : { note }),
  });
  if (!(await saveUpload(bucket, upload, etag))) {
    return problem(
      409,
      'changed-meanwhile',
      'The upload was changed while this was written. Try again.',
    );
  }
  // Approved, it is written into the media at once (docs/SPEC.md §8), and the answer says how
  // that went: published, sent back, or waiting, and why.
  if (status === 'accepted' && (await isLive(ctx))) {
    const publishing = await publishNow(ctx, actor, [upload.id]);
    const after = (await readUpload(bucket, upload.id))?.upload ?? upload;
    return json({ ...view(after), publishing });
  }
  return json(view(upload));
};

// ---- The routes

const UPLOAD = '(u-[0-9a-z]{11}-[0-9a-z]{8})';
const ROUTES: [RegExp, Partial<Record<string, Route>>][] = [
  [/^\/api\/content$/, { GET: content }],
  [/^\/api\/openapi\.json$/, { GET: openapi }],
  [/^\/api\/schemas\/([a-z]+)\.json$/, { GET: schema }],
  [/^\/api\/uploads$/, { GET: list, POST: create }],
  [new RegExp(`^/api/uploads/${UPLOAD}$`), { GET: read, DELETE: withdraw }],
  [new RegExp(`^/api/uploads/${UPLOAD}/files/([a-z][A-Za-z-]*)$`), { GET: file }],
  [
    new RegExp(`^/api/uploads/${UPLOAD}/languages/([A-Za-z-]+)$`),
    { PUT: putLanguage, DELETE: deleteLanguage },
  ],
  [new RegExp(`^/api/uploads/${UPLOAD}/status$`), { POST: setStatus }],
  [/^\/api\/library$/, { GET: libraryStatus }],
  [/^\/api\/library\/import$/, { POST: importRoute }],
  [/^\/api\/publish$/, { POST: publishRoute }],
  [/^\/api\/publications$/, { GET: publicationsRoute }],
  [new RegExp(`^/api/publications/${MOMENT}$`), { GET: publicationRoute }],
  [/^\/api\/library\/staged\/([0-9a-f]{64})$/, { PUT: stageRoute }],
  [/^\/api\/library\/files$/, { POST: filesRoute }],
  [/^\/api\/library\/archive$/, { POST: archiveRoute }],
];

/** The answer to a request of the API; undefined for a path that is none of its. */
export function uploadsApi(request: Request, ctx: Context): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  for (const [pattern, methods] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const route = methods[request.method];
    if (!route) {
      const response = problem(
        405,
        'method-not-allowed',
        `${pathname} takes ${Object.keys(methods).join(', ')}.`,
      );
      response.headers.set('Allow', Object.keys(methods).join(', '));
      return Promise.resolve(response);
    }
    return route(request, ctx, match.slice(1));
  }
  if (/^\/api\/uploads\/[^/]+/.test(pathname) && !isUploadId(pathname.split('/')[3] ?? '')) {
    return Promise.resolve(
      problem(404, 'not-found', `There is no upload ${pathname.split('/')[3]}.`),
    );
  }
  return undefined;
}
