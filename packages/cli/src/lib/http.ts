import type { Profile } from './config';
import { stripTrailingSlash } from './config';

/**
 * Standard exit codes for the CLI. Commander itself exits 1 on parse / help
 * errors (see `bin.ts`); these cover runtime/API failures so shells and CI
 * can branch on them.
 */
export const EXIT = {
  GENERAL: 1,
  /** Not signed in / no usable token. */
  UNAUTHENTICATED: 2,
  /** Token lacks the required scope (OAuth INSUFFICIENT_SCOPE / 403). */
  FORBIDDEN: 3,
  /** Resource not found (404). */
  NOT_FOUND: 4,
  /** Optimistic-lock / edit conflict (409). */
  CONFLICT: 5,
  /** Bad request / client validation (400 / 422). */
  INVALID: 6,
  /** Server unavailable / feature disabled (503). */
  UNAVAILABLE: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A CLI-level error carrying a process exit code and, when the failure came
 * from the API, the server-provided error `code`. `bin.ts` prints
 * `crowi: <message>` and exits with `exitCode`.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** Crowi error envelope `code` (e.g. `PAGE_NOT_FOUND`), when available. */
  readonly apiCode?: string;
  /** HTTP status, when the error originated from a response. */
  readonly status?: number;
  /**
   * The response body as parsed by {@link parseResponse} (JSON value, raw
   * text, or `undefined`), when the error originated from a response.
   * `apiCode`/`message` are a lenient, partial read of this (see
   * `parseCrowiError`'s doc comment) — a caller that needs to confirm the
   * body is a COMPLETE, schema-valid envelope (not just "has a `code`
   * field") should re-validate this directly against its own zod schema
   * rather than trust `apiCode` alone.
   */
  readonly rawBody?: unknown;

  constructor(message: string, opts: { exitCode?: ExitCode; apiCode?: string; status?: number; rawBody?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? EXIT.GENERAL;
    this.apiCode = opts.apiCode;
    this.status = opts.status;
    this.rawBody = opts.rawBody;
  }
}

/** Map an HTTP status to a CLI exit code. */
function statusToExit(status: number): ExitCode {
  switch (status) {
    case 401:
      return EXIT.UNAUTHENTICATED;
    case 403:
      return EXIT.FORBIDDEN;
    case 404:
      return EXIT.NOT_FOUND;
    case 409:
      return EXIT.CONFLICT;
    case 400:
    case 422:
      return EXIT.INVALID;
    case 503:
      return EXIT.UNAVAILABLE;
    default:
      return EXIT.GENERAL;
  }
}

/** Crowi's error envelope: `{ error: { code, message } }`. */
interface CrowiErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Extract a `{ error: { code, message } }` envelope from a parsed body, if
 * it matches the Crowi shape. Tolerates extra fields and partial envelopes.
 */
function parseCrowiError(body: unknown): { code?: string; message?: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const env = body as CrowiErrorEnvelope;
  if (typeof env.error !== 'object' || env.error === null) return undefined;
  const { code, message } = env.error;
  if (code === undefined && message === undefined) return undefined;
  return {
    code: typeof code === 'string' ? code : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * The body type accepted by the global `fetch` (e.g. a string, a `Blob`, or
 * a `FormData`). Derived from `RequestInit` rather than the DOM-only
 * `BodyInit` global, which `@types/node` does not expose.
 */
type FetchBody = NonNullable<RequestInit['body']>;

export interface AuthedFetchOptions {
  /** JSON body to send (serialised + `Content-Type: application/json`). */
  json?: unknown;
  /** Raw query parameters appended to the path. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /**
   * Body to send as-is (e.g. a `FormData` for multipart). Mutually
   * exclusive with `json`. The caller is responsible for not setting a
   * conflicting `Content-Type`.
   */
  body?: FetchBody;
}

/**
 * Hook the next stage fills in: given a profile whose access token was
 * rejected (401), perform a single coalesced `refresh_token` grant, persist
 * the rotated tokens, and return the new access token (or `undefined` if
 * refresh is impossible / fails). Stubbed to `undefined` for now so the 401
 * path simply surfaces an "unauthenticated" error until refresh lands.
 */
export type RefreshHook = (profile: Profile) => Promise<string | undefined>;

let refreshHook: RefreshHook | undefined;

/**
 * Register the 401→refresh→retry hook. The login/oauth stage calls this
 * once at startup so `authedFetch` can transparently refresh expired access
 * tokens. Until then the seam is a no-op.
 */
export function setRefreshHook(hook: RefreshHook | undefined): void {
  refreshHook = hook;
}

/** Build a `<base>/api<path>` URL with optional query params. */
export function apiUrl(endpoint: string, path: string, query?: AuthedFetchOptions['query']): string {
  const base = `${stripTrailingSlash(endpoint)}/api`;
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${normalisedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function buildHeaders(profile: Profile, opts: AuthedFetchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...opts.headers,
  };
  const token = profile.tokens?.accessToken;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.json !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildBody(opts: AuthedFetchOptions): FetchBody | undefined {
  if (opts.json !== undefined) {
    return JSON.stringify(opts.json);
  }
  return opts.body;
}

/**
 * Authenticated fetch against `<endpoint>/api<path>`. Injects the
 * profile's bearer token, parses responses LENIENTLY (returns the parsed
 * JSON as `unknown` — callers narrow / validate), and maps the Crowi error
 * envelope `{ error: { code, message } }` to a thrown {@link CliError} with
 * an exit code derived from the HTTP status.
 *
 * On a 401 it invokes the registered {@link RefreshHook} (if any) once,
 * persists the rotated token via the hook, and retries the request a single
 * time. Without a refresh hook a 401 surfaces as an authentication error.
 */
export async function authedFetch<T = unknown>(profile: Profile, method: HttpMethod, path: string, opts: AuthedFetchOptions = {}): Promise<T> {
  if (!profile.endpoint) {
    throw new CliError('no server configured — run `crowi login <url>` first', {
      exitCode: EXIT.UNAUTHENTICATED,
    });
  }
  const url = apiUrl(profile.endpoint, path, opts.query);

  const doFetch = async (current: Profile): Promise<Response> =>
    fetch(url, {
      method,
      headers: buildHeaders(current, opts),
      body: buildBody(opts),
    });

  let response = await doFetch(profile);

  // 401 → single coalesced refresh + retry (the next stage wires the hook).
  if (response.status === 401 && refreshHook && profile.tokens?.refreshToken) {
    const newAccess = await refreshHook(profile);
    if (newAccess) {
      const refreshed: Profile = {
        ...profile,
        tokens: { ...profile.tokens, accessToken: newAccess },
      };
      response = await doFetch(refreshed);
    }
  }

  return parseResponse<T>(response);
}

/**
 * {@link authedFetch} for endpoints whose body is bytes rather than JSON:
 * the `Response` is handed back unread so the caller can stream it.
 *
 * Two deliberate differences from `authedFetch`:
 *
 * - **Redirects are not followed** (`redirect: 'manual'`). The default is
 *   to follow, which means a reverse proxy or an SSO gateway can answer a
 *   binary request with `200 text/html` for a login page and the caller
 *   would write that HTML out as if it were the file. A redirect on this
 *   kind of endpoint is a misconfiguration, so surfacing it is better than
 *   chasing it.
 * - **`Accept-Encoding: identity`** so a content coding cannot make the
 *   received byte count disagree with what the server accounted for.
 *
 * Non-2xx still becomes a {@link CliError} through the shared parser, so
 * error envelopes read identically to every other command.
 */
export async function authedFetchRaw(profile: Profile, path: string, opts: AuthedFetchOptions = {}): Promise<Response> {
  if (!profile.endpoint) {
    throw new CliError('no server configured — run `crowi login <url>` first', {
      exitCode: EXIT.UNAUTHENTICATED,
    });
  }
  const url = apiUrl(profile.endpoint, path, opts.query);

  const doFetch = async (current: Profile): Promise<Response> =>
    fetch(url, {
      method: 'GET',
      headers: { ...buildHeaders(current, opts), 'Accept-Encoding': 'identity' },
      redirect: 'manual',
    });

  let response = await doFetch(profile);

  if (response.status === 401 && refreshHook && profile.tokens?.refreshToken) {
    const newAccess = await refreshHook(profile);
    if (newAccess) {
      const refreshed: Profile = {
        ...profile,
        tokens: { ...profile.tokens, accessToken: newAccess },
      };
      response = await doFetch(refreshed);
    }
  }

  // With `redirect: 'manual'` a redirect surfaces as the 3xx itself (undici)
  // or as an opaque filtered response with status 0 (the fetch spec's
  // browser behaviour). Name both, because the default parser would render
  // them as an unhelpful "request failed with status 0".
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get('location');
    throw new CliError(
      `server redirected a binary request${location ? ` to ${location}` : ''} — refusing to follow it (check the endpoint / any proxy in front of it)`,
      {
        exitCode: EXIT.GENERAL,
        status: response.status,
      },
    );
  }

  if (!response.ok) {
    // Let the shared parser turn the envelope into a CliError. It consumes
    // the body, which is correct here: this is the failure path, so there
    // are no bytes worth preserving.
    await parseResponse<unknown>(response);
  }

  return response;
}

/**
 * Parse a fetch `Response` leniently: JSON bodies are returned as `unknown`;
 * non-2xx responses are mapped to a {@link CliError}, preferring the Crowi
 * `{ error: { code, message } }` envelope for the message + code.
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  if (text.trim() === '') {
    body = undefined;
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON body. Keep the raw text so error messages stay useful.
      body = text;
    }
  }

  if (response.ok) {
    return body as T;
  }

  const envelope = parseCrowiError(body);
  const message = envelope?.message ?? (typeof body === 'string' && body.trim() !== '' ? body.trim() : `request failed with status ${response.status}`);

  throw new CliError(message, {
    exitCode: statusToExit(response.status),
    apiCode: envelope?.code,
    status: response.status,
    rawBody: body,
  });
}
