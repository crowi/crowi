import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Command } from 'commander';

import { authedFetch, authedFetchRaw, CliError, EXIT } from '../lib/http';
import { info, render } from '../lib/output';
import { fetchCurrentPage } from '../lib/page-write';
import { fetchUploadPolicy, resolveDeclaredMediaType } from '../lib/upload-policy';
import { requireProfile, rethrowScopeHint } from './_shared';

/**
 * Lenient views of the attachment responses
 * (ListAttachmentsResponseSchema / AddAttachmentResponseSchema).
 */
interface AttachmentView {
  _id?: string;
  originalName?: string;
  fileName?: string;
  fileSize?: number;
  url?: string;
}
interface ListAttachmentsResponse {
  attachments?: AttachmentView[];
}
interface AddAttachmentResponse {
  attachment?: AttachmentView;
  url?: string;
}

/**
 * `crowi attach list <path-or-id>` — list a page's attachments
 * (`GET /api/pages/{pageId}/attachments`, needs `attachments:read`).
 */
async function runList(pathOrId: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  // No capability pre-flight: `attachments` is in the static baseline; the
  // real gate is the `attachments:read` scope (rethrowScopeHint below).
  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }

  let body: ListAttachmentsResponse;
  try {
    body = await authedFetch<ListAttachmentsResponse>(profile, 'GET', `/pages/${current.pageId}/attachments`);
  } catch (err) {
    rethrowScopeHint(err, 'attachments:read');
  }

  const attachments = body.attachments ?? [];
  render(
    body,
    () => {
      if (attachments.length === 0) return '(no attachments)';
      // The id leads each row because it is what `crowi attach download`
      // takes, and it is a fixed 24 characters, so the names line up without
      // any padding work.
      return attachments.map((a) => `${a._id ?? '(no id)'.padEnd(24)}  ${a.originalName ?? a.fileName ?? '(unnamed)'}  ${a.url ?? ''}`.trimEnd()).join('\n');
    },
    globals,
  );
}

/**
 * `crowi attach add <path-or-id> <file>` — upload a local file to a page
 * (`POST /api/pages/{pageId}/attachments`, multipart, needs
 * `attachments:write`). Builds a `FormData` from the Node 18+ globals; the
 * boundary `Content-Type` is set by `fetch`, so we never set it ourselves.
 */
async function runAdd(pathOrId: string, file: string, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  // No capability pre-flight (see runList) — the genuine gate is the
  // `attachments:write` scope, surfaced via rethrowScopeHint below.
  const current = await fetchCurrentPage(profile, pathOrId);
  if (!current?.pageId) {
    throw new CliError(`page not found: ${pathOrId}`, { exitCode: EXIT.NOT_FOUND });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(`cannot read ${file}: ${reason}`, { exitCode: EXIT.INVALID });
  }

  const name = basename(file);
  // Ask the server what it actually accepts (cached on the profile; a 404
  // degrades to the local `media-type.ts` table, so an old server sees no
  // regression) and reject an obviously-doomed upload locally instead of
  // paying for the round trip.
  const policy = await fetchUploadPolicy(profile);
  const declaredType = resolveDeclaredMediaType(name, policy);
  if (policy) {
    if (!policy.allowedMimeTypes.includes(declaredType)) {
      throw new CliError(`upload rejected: ${file} has type ${declaredType}, which this server does not accept for attachments`, {
        exitCode: EXIT.INVALID,
      });
    }
    if (bytes.byteLength > policy.maxBytes.attachment) {
      throw new CliError(
        `upload rejected: ${file} (${bytes.byteLength} bytes) exceeds the server's attachment size limit (${policy.maxBytes.attachment} bytes)`,
        {
          exitCode: EXIT.INVALID,
        },
      );
    }
  }

  const form = new FormData();
  // Node 18+ globals: Blob / File / FormData. The declared `type` matters: the
  // api stores it verbatim as the attachment's `fileFormat`, and delivery only
  // serves an allow-listed type inline — a Blob built without one declares
  // `application/octet-stream` and comes back as a download, image or not.
  // A browser gets this from the file picker; in Node we derive it from the
  // name.
  const blob = new Blob([bytes], { type: declaredType });
  form.append('file', blob, name);

  let body: AddAttachmentResponse;
  try {
    body = await authedFetch<AddAttachmentResponse>(profile, 'POST', `/pages/${current.pageId}/attachments`, { body: form });
  } catch (err) {
    if (err instanceof CliError && err.status === 413) {
      throw new CliError(`upload rejected: ${file} exceeds the server's attachment size limit`, { exitCode: EXIT.INVALID });
    }
    rethrowScopeHint(err, 'attachments:write');
  }

  const url = body.url ?? body.attachment?.url ?? '';
  render(body, () => `Uploaded ${basename(file)} to ${current.path ?? pathOrId}.${url ? `\n${url}` : ''}`, globals);
}

/** A 24-hex MongoDB ObjectId — what the download route's path pattern accepts. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Read the original filename out of a `Content-Disposition`. Only the
 * RFC 5987 `filename*=UTF-8''<pct-encoded>` form is recognised, because that
 * is the only form the download route emits. Returns `undefined` for
 * anything else rather than guessing.
 */
function filenameFromDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** Yield every chunk of `source` unchanged while accumulating the byte count. */
async function* counting(source: AsyncIterable<Uint8Array>, tally: { bytes: number }): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    tally.bytes += chunk.byteLength;
    yield chunk;
  }
}

/**
 * `crowi attach download <id> [-o <file>]` — write an attachment's bytes to
 * a file, or to stdout when `-o` is omitted
 * (`GET /api/attachments/{id}/download`, needs `attachments:read`).
 *
 * This is the strict delivery route, not the one an `<img>` uses: a missing
 * record or a missing stored object is a 404 rather than the placeholder
 * image, so a saved file is always the real attachment.
 */
async function runDownload(id: string, options: { output?: string }, command: Command): Promise<void> {
  const { profile, globals } = requireProfile(command);
  const outPath = options.output;

  if (!OBJECT_ID.test(id)) {
    throw new CliError(`not an attachment id: ${id} (expected 24 hex characters — \`crowi attach list <page>\` shows them)`, {
      exitCode: EXIT.INVALID,
    });
  }
  // Binary down a terminal corrupts the display and helps nobody; `curl`
  // refuses the same way. Redirecting or piping clears `isTTY`.
  if (!outPath && process.stdout.isTTY) {
    throw new CliError('refusing to write binary data to the terminal — pass `-o <file>` or redirect stdout', { exitCode: EXIT.INVALID });
  }
  // `--json` prints to stdout, which the bytes already own in this mode.
  if (globals.json && !outPath) {
    throw new CliError('`--json` needs `-o <file>` here, since the attachment itself is written to stdout', { exitCode: EXIT.INVALID });
  }

  let response: Response;
  try {
    response = await authedFetchRaw(profile, `/attachments/${id}/download`);
  } catch (err) {
    rethrowScopeHint(err, 'attachments:read');
  }

  // Validate BEFORE a single byte is written. The route always answers with
  // `application/octet-stream` + an attachment disposition, so anything else
  // arriving as a 200 came from something other than the route — a captive
  // portal or an SSO gateway returning its own page — and writing it out
  // would produce a file that looks saved but holds HTML.
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const disposition = response.headers.get('content-disposition');
  if (contentType !== 'application/octet-stream' || !disposition?.trimStart().toLowerCase().startsWith('attachment')) {
    throw new CliError(`unexpected response for a download (content-type: ${contentType || '(none)'}) — not writing it out`, {
      exitCode: EXIT.GENERAL,
      status: response.status,
    });
  }
  if (!response.body) {
    throw new CliError('the server returned an empty response body', { exitCode: EXIT.GENERAL, status: response.status });
  }

  // A chunked response carries no Content-Length, and `Number(null)` is 0 —
  // so an absent header must be turned into "no expectation" explicitly, or
  // every chunked download would look like a 0-byte one that overran.
  const lengthHeader = response.headers.get('content-length')?.trim();
  const declaredLength = lengthHeader ? Number(lengthHeader) : Number.NaN;
  const expected = Number.isInteger(declaredLength) && declaredLength >= 0 ? declaredLength : undefined;
  const tally = { bytes: 0 };
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  const sink: Writable = outPath ? createWriteStream(outPath) : process.stdout;

  try {
    // `end: false` matters for stdout — closing it would break anything the
    // process still wants to print, and for a file the stream is ours to end.
    await pipeline(counting(source, tally), sink, { end: sink !== process.stdout });
    if (expected !== undefined && tally.bytes !== expected) {
      throw new CliError(`truncated download: expected ${expected} bytes, received ${tally.bytes}`, { exitCode: EXIT.GENERAL });
    }
  } catch (err) {
    // A partial file is worse than none: it looks like a successful download
    // to everything downstream. Remove it before reporting the failure.
    if (outPath) await unlink(outPath).catch(() => undefined);
    // `crowi attach download <id> | head -c 100` closes the pipe early. That
    // is the caller getting what they asked for, not an error.
    if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return;
    if (err instanceof CliError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(`failed to write the attachment${outPath ? ` to ${outPath}` : ''}: ${reason}`, { exitCode: EXIT.GENERAL });
  }

  if (!outPath) return;
  const filename = filenameFromDisposition(disposition);
  if (globals.json) {
    render({ id, path: outPath, bytes: tally.bytes, filename }, undefined, globals);
    return;
  }
  // Human mode keeps stdout empty: the interesting output is the file, and a
  // confirmation line on stdout would differ from the `-o`-less form for no
  // reason. `info` writes to stderr and honours `--quiet`.
  info(`Saved ${filename ?? id} to ${outPath} (${tally.bytes} bytes).`, globals);
}

/** Register the `attach` command group (`list` / `add` / `download`). */
export function registerAttach(program: Command): void {
  const attach = program.command('attach').description('List, upload or download page attachments (needs attachments:* scope)');

  attach
    .command('list <path-or-id>')
    .description("List a page's attachments")
    .action(async (pathOrId: string, _options: unknown, command: Command) => {
      await runList(pathOrId, command);
    });

  attach
    .command('add <path-or-id> <file>')
    .description('Upload a local file as an attachment on a page')
    .action(async (pathOrId: string, file: string, _options: unknown, command: Command) => {
      await runAdd(pathOrId, file, command);
    });

  attach
    .command('download <id>')
    .description('Download one attachment by id (`attach list` shows ids); writes to stdout unless -o is given')
    .option('-o, --output <file>', 'write to this file instead of stdout')
    .action(async (id: string, options: { output?: string }, command: Command) => {
      await runDownload(id, options, command);
    });
}
