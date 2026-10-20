/** The Worker's answers: JSON, never cached, and its errors in one shape. */

/** Something wrong with what was sent, at its place in it. */
export interface Issue {
  /** Where, as the names and indexes that lead to it: `languages.fr.slide.elements.3.frame`. */
  path: string;
  message: string;
  /** The language whose content it is in, when it is in one. */
  language?: string;
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const all = new Headers(headers);
  all.set('Content-Type', 'application/json; charset=utf-8');
  all.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(value), { status, headers: all });
}

/**
 * An error: a code a program can test (`not-found`, `invalid`), what it means in words, and for
 * content that does not hold, every issue found in it.
 */
export function problem(status: number, error: string, message: string, issues?: Issue[]) {
  return json({ error, message, ...(issues?.length ? { issues } : {}) }, status);
}

/** The JSON body of a request, or the answer to give when it has none. */
export async function jsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return problem(415, 'unsupported-media-type', 'Send the body as application/json.');
  }
  try {
    return (await request.json()) as unknown;
  } catch {
    return problem(400, 'bad-json', 'The body is not JSON.');
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
