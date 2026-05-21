/**
 * RFC-0006 Phase 6 Sub-batch B — Hono-owned `http.Server` shim that
 * still delegates to the Express app for any path Hono does not match.
 *
 * Once Hono owns the `http.Server` (via `@hono/node-server`'s
 * `createAdaptorServer({ fetch: honoApp.fetch })`) every inbound HTTP
 * request enters Hono first. `/api/v2/*` is fully migrated, so the
 * Hono router answers it directly. For everything else (legacy SSR
 * routes, `/_api/*` RPC, OAuth callbacks) we hand the Web `Request`
 * back to Express by:
 *
 *   1. Synthesising a Node `IncomingMessage` over a `PassThrough`
 *      socket from the request body bytes.
 *   2. Synthesising a `ServerResponse` whose `write` / `end` are
 *      overridden to capture body chunks, and whose `_writeRaw`
 *      is no-op'd to keep the underlying socket clean.
 *   3. Reading `statusCode` / `statusMessage` / `getHeaders()` /
 *      captured body chunks off the response and building a Web
 *      `Response`.
 *
 * Sub-batch D removes Express entirely; this adapter goes away with
 * the dependency. While it lives the Express middleware stack
 * (cors, session, passport, BasicAuth, LoginChecker) continues to
 * apply to legacy paths — Sub-batch C re-implements that stack on
 * Hono and decouples it from the bridge.
 *
 * Best-effort fidelity: there's no streaming response support and no
 * EventEmitter passthrough beyond `'finish'`. None of the currently-
 * mounted legacy routes need either — they are user-tested as dead
 * code on Crowi 2.0 deployments (Next.js renders the SSR pages, the
 * Hono `/api/v2/*` answers every live API call). The fallback exists
 * purely so a stray request during the migration window still
 * receives a sensible status code instead of a connection error.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Express } from 'express';

/**
 * Convert a Web `Request` into the Node `IncomingMessage` /
 * `ServerResponse` pair Express expects, invoke the Express app
 * once, then read the captured response back into a Web `Response`.
 *
 * Resolves when Express calls `res.end()` (signalled via the
 * `'finish'` event on the synthetic `ServerResponse`). The
 * `IncomingMessage` body stream is closed immediately after the
 * request body has been pushed in, so middlewares that wait on the
 * stream's `'end'` event (e.g. `express.json()`, `multer`) see the
 * full payload.
 */
export async function callExpressAsFetch(expressApp: Express, request: Request): Promise<Response> {
  // The synthetic socket carries both directions in principle, but
  // we never actually read raw bytes off it — the body is pushed
  // directly via `IncomingMessage.push` and the response is
  // captured via the overridden `write` / `end`. A single
  // `PassThrough` is sufficient as a stand-in `net.Socket` so the
  // Node http internals stop complaining about a missing socket.
  const socket = new PassThrough() as unknown as Socket;

  const url = new URL(request.url);
  const incoming = new IncomingMessage(socket);
  incoming.method = request.method;
  // Express reads `req.url` (path + query) and `req.headers.host`
  // separately; matching that convention here keeps the route
  // matching identical to a real `http.Server` request.
  incoming.url = `${url.pathname}${url.search}`;

  const headers: Record<string, string | string[]> = {};
  // `Headers.forEach` collapses duplicate `set-cookie` entries on
  // the iteration side, but inbound requests rarely carry multiple
  // `set-cookie`s (that's a response header), so the flat record is
  // sufficient for the request side.
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (!headers.host) {
    headers.host = url.host;
  }
  incoming.headers = headers;

  const bodyBuf = request.method === 'GET' || request.method === 'HEAD' ? null : Buffer.from(new Uint8Array(await request.arrayBuffer()));
  if (bodyBuf !== null && bodyBuf.length > 0) {
    // Re-write `content-length` to match the actual bytes we're
    // about to push. The original header (if any) reflects the
    // wire payload, which may have already been re-serialised by
    // the Hono `Request` constructor.
    incoming.headers['content-length'] = String(bodyBuf.length);
  }

  const response = new ServerResponse(incoming);
  response.assignSocket(socket);

  const bodyChunks: Buffer[] = [];

  // `_writeRaw` is the private hook the http internals use to flush
  // the headers + chunked frames onto the socket. Override to a no-op
  // so the captured `bodyChunks` aren't doubled by the wire bytes
  // ServerResponse would otherwise emit through the socket.
  type ResponseWithInternals = ServerResponse & {
    _writeRaw: (data: unknown, encoding: unknown, callback?: () => void) => boolean;
  };
  (response as ResponseWithInternals)._writeRaw = (_data, encoding, callback) => {
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };

  type Callback = (err?: Error | null) => void;
  type WriteArgs = [chunk: unknown, encoding?: BufferEncoding | Callback, cb?: Callback];

  const collectChunk = (chunk: unknown, encoding?: BufferEncoding | Callback): void => {
    if (chunk == null) return;
    if (Buffer.isBuffer(chunk)) {
      bodyChunks.push(chunk);
      return;
    }
    if (typeof chunk === 'string') {
      const enc: BufferEncoding = typeof encoding === 'string' ? encoding : 'utf8';
      bodyChunks.push(Buffer.from(chunk, enc));
      return;
    }
    if (chunk instanceof Uint8Array) {
      bodyChunks.push(Buffer.from(chunk));
    }
  };

  // Reassign `write`. We retain `return true` for back-pressure
  // signalling since no real socket is gating us.
  response.write = ((...args: WriteArgs) => {
    const [chunk, encoding, cb] = args;
    collectChunk(chunk, encoding);
    const callback = typeof encoding === 'function' ? encoding : cb;
    if (typeof callback === 'function') callback();
    return true;
  }) as ServerResponse['write'];

  const finished = new Promise<void>((resolveFinish, rejectFinish) => {
    response.once('finish', () => resolveFinish());
    response.once('error', (err: Error) => rejectFinish(err));
  });

  response.end = ((...args: WriteArgs) => {
    const [chunk, encoding, cb] = args;
    if (typeof chunk !== 'function') {
      collectChunk(chunk, encoding);
    }
    // Express expects `.end` to be synchronous in terms of state
    // transition but `'finish'` to fire asynchronously. Mirror that
    // by scheduling the event on the next tick.
    setImmediate(() => response.emit('finish'));
    const finishCb = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
    if (typeof finishCb === 'function') finishCb();
    return response;
  }) as ServerResponse['end'];

  // Express is a `(req, res) => void` function — invoke it directly.
  // Any throw / async rejection inside a middleware bubbles to the
  // Express error handler (set up in `crowi.buildServer()`), which
  // ends up calling `res.end()` itself; our `finished` promise then
  // resolves and the response carries the error status.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expressApp as unknown as (req: any, res: any) => void)(incoming, response);

  // Feed the request body in after dispatching so middlewares that
  // call `req.on('data', ...)` get every chunk.
  if (bodyBuf !== null && bodyBuf.length > 0) {
    incoming.push(bodyBuf);
  }
  incoming.push(null);

  await finished;

  const outHeaders = new Headers();
  for (const [name, raw] of Object.entries(response.getHeaders())) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      // `set-cookie` is the canonical multi-value header. `Headers.append`
      // preserves every entry distinctly so `getSetCookie()` on the
      // returned `Response` round-trips correctly.
      for (const v of raw) outHeaders.append(name, String(v));
    } else {
      outHeaders.set(name, String(raw));
    }
  }

  const status = response.statusCode || 200;
  // Web `Response` constructor rejects body for 204 / 205 / 304 /
  // 1xx. Pass `null` in those cases — Express may have set body
  // bytes anyway (e.g. an old middleware that ignored 204 semantics)
  // but the body would never have been observed by a real client
  // either.
  const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
  const bodyForResponse = NULL_BODY_STATUSES.has(status) || (status >= 100 && status < 200) ? null : Buffer.concat(bodyChunks);

  return new Response(bodyForResponse, {
    status,
    statusText: response.statusMessage,
    headers: outHeaders,
  });
}
