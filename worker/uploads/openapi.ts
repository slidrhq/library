/**
 * The API, as OpenAPI 3.1 (`GET /api/openapi.json`), written from the parts of the library
 * themselves (`content.ts`), so it says what the Worker takes. A slide and a template's sample
 * are described by the model's own JSON Schema, at `/api/schemas/`.
 */
import { CONTENT_LANGUAGES, type ContentLanguage } from '@slidr/model';
import { PARTS } from './content.ts';
import { ACTIONS, type Field, type Handler } from './handler.ts';
import { STATUSES } from './store.ts';
import { TAGS_FEWEST, TAGS_MOST } from './tags.ts';

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

/** The search tags of one item in one language (`tags.ts`). */
const TAGS: Schema = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 40 },
  minItems: TAGS_FEWEST,
  maxItems: TAGS_MOST,
  uniqueItems: true,
};

/** The JSON Schema of a field, by the type its description names. */
const SCHEMA_OF: Record<string, Schema> = {
  string: { type: 'string', minLength: 1, maxLength: 80 },
  '[x, y]': { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
  Slide: { $ref: 'schemas/slide.json' },
  'SampleSlide[]': { $ref: 'schemas/sample.json' },
  Tags: TAGS,
  'Record<key, Tags>': { type: 'object', minProperties: 1, additionalProperties: TAGS },
};

const fieldSchema = (field: Field): Schema => ({
  ...(SCHEMA_OF[field.type] ?? {}),
  description: field.about,
});

/** The content of one language, as the handler takes it in `lang`. */
function languageSchema(handler: Handler, lang: ContentLanguage): Schema {
  const fields = handler.languageFields.filter(
    (field) => !field.languages || field.languages.includes(lang),
  );
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])),
    required: fields.filter((field) => field.required).map((field) => field.name),
    additionalProperties: false,
  };
}

/** An upload of one kind: its type and action, its id, its fields and its languages. */
function uploadSchema(handler: Handler): Schema {
  const { allowed, required } = handler.languages;
  return {
    title: `${handler.type}: ${handler.action}`,
    description: handler.about,
    type: 'object',
    properties: {
      type: { const: handler.type },
      action: { const: handler.action },
      id: { type: 'string', description: handler.id },
      ...Object.fromEntries(handler.fields.map((field) => [field.name, fieldSchema(field)])),
      languages: {
        type: 'object',
        description:
          `The content in each language. Uploaded in ${required.join(' and ') || 'one language at least'}; ` +
          (handler.languages.complete.length > 0
            ? `accepted when written in all of ${handler.languages.complete.join(', ')}.`
            : 'accepted in the languages it has.'),
        properties: Object.fromEntries(
          allowed.map((lang) => [lang, languageSchema(handler, lang)]),
        ),
        required,
        minProperties: 1,
        additionalProperties: false,
      },
    },
    required: [
      'type',
      'action',
      'id',
      'languages',
      ...handler.fields.filter((field) => field.required).map((field) => field.name),
    ],
    additionalProperties: false,
  };
}

const HANDLERS = PARTS.flatMap((part) => part.handlers);
const FILE_NAMES = [
  ...new Set(HANDLERS.flatMap((handler) => handler.files.map((one) => one.name))),
];

const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [String(code), { $ref: `#/components/responses/${code}` }]),
  );

const uploadId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^u-[0-9a-z]{11}-[0-9a-z]{8}$' },
};

const anUpload = {
  description: 'The upload.',
  content: { 'application/json': { schema: ref('Upload') } },
};

export function openApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Slidr Library uploads',
      version: '1',
      description:
        'Content uploaded to the Slidr media library: each part of the library, in the languages ' +
        'it is written in. An upload waits to be accepted, and is published with the library. ' +
        '`GET /api/content` says what each part takes.',
    },
    servers: [{ url: '/' }],
    // The uploads are the library's editors': signed in on its page, or a program by its key.
    security: [{ session: [] }, { key: [] }],
    paths: {
      '/api/content': {
        get: {
          summary: 'The parts of the library, its languages, and what each part takes',
          security: [],
          responses: {
            200: {
              description: 'The parts and the languages.',
              content: { 'application/json': { schema: ref('Content') } },
            },
          },
        },
      },
      '/api/schemas/{name}.json': {
        get: {
          summary: "The JSON Schema of a slide, or of a template's sample",
          security: [],
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { enum: ['slide', 'sample'] } },
          ],
          responses: { 200: { description: 'A JSON Schema (draft 2020-12).' }, ...errors(404) },
        },
      },
      '/api/uploads': {
        get: {
          summary: 'The uploads, newest first',
          parameters: [
            { name: 'type', in: 'query', schema: { enum: PARTS.map((part) => part.type) } },
            { name: 'action', in: 'query', schema: { enum: ACTIONS } },
            { name: 'status', in: 'query', schema: { enum: STATUSES } },
            {
              name: 'target',
              in: 'query',
              schema: { type: 'string' },
              description: "The item's id in the library.",
            },
            {
              name: 'language',
              in: 'query',
              schema: { enum: CONTENT_LANGUAGES },
              description: 'Uploads written in it.',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: 'after',
              in: 'query',
              schema: { type: 'string' },
              description: 'The `next` of the page before.',
            },
          ],
          responses: {
            200: {
              description: 'A page of uploads; `next` names the last of it when more follow.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      uploads: { type: 'array', items: ref('Summary') },
                      next: { type: 'string' },
                    },
                    required: ['uploads'],
                  },
                },
              },
            },
            ...errors(401, 403, 400, 503),
          },
        },
        post: {
          summary: 'Uploads content',
          description:
            'As JSON when the upload brings no files, else as a form: the upload as JSON in the part ' +
            '`upload`, and each file in a part of its name.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: ref('UploadRequest') },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    upload: ref('UploadRequest'),
                    ...Object.fromEntries(
                      FILE_NAMES.map((name) => [
                        name,
                        { type: 'string', contentMediaType: 'image/webp' },
                      ]),
                    ),
                  },
                  required: ['upload'],
                },
                encoding: { upload: { contentType: 'application/json' } },
              },
            },
          },
          responses: {
            201: { ...anUpload, headers: { Location: { schema: { type: 'string' } } } },
            ...errors(401, 403, 400, 413, 415, 422, 503),
          },
        },
      },
      '/api/uploads/{id}': {
        parameters: [uploadId],
        get: {
          summary: 'One upload, all it holds',
          responses: { 200: anUpload, ...errors(401, 403, 404) },
        },
        delete: {
          summary: 'Withdraws an upload that waits, or was rejected',
          responses: {
            204: { description: 'Withdrawn, with its files.' },
            ...errors(401, 403, 404, 409),
          },
        },
      },
      '/api/uploads/{id}/files/{name}': {
        parameters: [
          uploadId,
          { name: 'name', in: 'path', required: true, schema: { enum: FILE_NAMES } },
        ],
        get: {
          summary: 'One of the files of an upload',
          responses: {
            200: { description: 'The file.', content: { 'image/webp': {} } },
            ...errors(401, 403, 404),
          },
        },
      },
      '/api/uploads/{id}/languages/{lang}': {
        parameters: [
          uploadId,
          { name: 'lang', in: 'path', required: true, schema: { enum: CONTENT_LANGUAGES } },
        ],
        put: {
          summary: 'Writes an upload that waits in a language, or again in one',
          description:
            "The body is the content of the language, as the upload's kind describes it.",
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: anUpload, ...errors(401, 403, 400, 404, 409, 415, 422, 503) },
        },
        delete: {
          summary: 'Takes away a language the upload may do without',
          responses: { 200: anUpload, ...errors(401, 403, 404, 409) },
        },
      },
      '/api/uploads/{id}/status': {
        parameters: [uploadId],
        post: {
          summary: 'Accepts an upload, rejects it, sends it back to wait, or says it is published',
          description:
            'pending → accepted or rejected; accepted → pending, rejected or published; rejected → ' +
            'pending. An upload is accepted when it holds against the library as it is, written in ' +
            'every language it needs.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { enum: STATUSES },
                    note: { type: 'string', maxLength: 1000 },
                  },
                  required: ['status'],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { 200: anUpload, ...errors(401, 403, 404, 409, 415, 422, 503) },
        },
      },
    },
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-library-session',
          description:
            'Signed in with a Google account the library names as an editor (`LIBRARY_EDITORS`), from the library’s own page (`/auth/login`). A request that changes something comes from that page (its `Origin`).',
        },
        key: {
          type: 'http',
          scheme: 'bearer',
          description: 'A program’s key, as the Worker’s `LIBRARY_KEYS` names it.',
        },
      },
      schemas: {
        UploadRequest: { oneOf: HANDLERS.map(uploadSchema) },
        Upload: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { enum: PARTS.map((part) => part.type) },
            action: { enum: ACTIONS },
            target: { type: 'string', description: "The item's id in the library." },
            fields: { type: 'object' },
            languages: { type: 'object', propertyNames: { enum: CONTENT_LANGUAGES } },
            missing: {
              type: 'array',
              items: { enum: CONTENT_LANGUAGES },
              description: 'The languages it still needs to be accepted.',
            },
            files: { type: 'object', additionalProperties: ref('File') },
            status: { enum: STATUSES },
            note: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
            by: ref('Actor'),
            history: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { enum: STATUSES },
                  at: { type: 'string', format: 'date-time' },
                  by: ref('Actor'),
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        Summary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            action: { type: 'string' },
            target: { type: 'string' },
            status: { enum: STATUSES },
            languages: { type: 'array', items: { enum: CONTENT_LANGUAGES } },
            created: { type: 'string', format: 'date-time' },
            updated: { type: 'string', format: 'date-time' },
            by: { type: 'string' },
          },
        },
        File: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Its place in the library once published.' },
            type: { type: 'string' },
            bytes: { type: 'integer' },
            sha256: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            url: { type: 'string' },
          },
        },
        Actor: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: "An account's address; `anyone` while there are no permissions.",
            },
            name: { type: 'string' },
          },
        },
        Content: {
          type: 'object',
          properties: {
            languages: { type: 'array', items: { type: 'object' } },
            types: { type: 'array', items: { type: 'object' } },
          },
        },
        Problem: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'A code to test: `invalid`, `not-found`, `incomplete`…',
            },
            message: { type: 'string' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  message: { type: 'string' },
                  language: { enum: CONTENT_LANGUAGES },
                },
                required: ['path', 'message'],
              },
            },
          },
          required: ['error', 'message'],
        },
      },
      responses: Object.fromEntries(
        [
          [400, 'The request could not be read.'],
          [401, 'Not signed in, or a key the library does not have.'],
          [403, 'An account that is not one of the editors, or a request from another site.'],
          [404, 'There is no such thing.'],
          [409, 'Not now: the upload is not in a status that allows it, or was changed meanwhile.'],
          [413, 'The upload is too large.'],
          [415, 'The body is not of a type this takes.'],
          [422, 'The upload does not hold: `issues` says where.'],
          [503, 'The server keeps no uploads, or the published library could not be read.'],
        ].map(([code, description]) => [
          String(code),
          { description, content: { 'application/json': { schema: ref('Problem') } } },
        ]),
      ),
    },
  };
}
