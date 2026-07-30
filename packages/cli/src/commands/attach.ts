import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { Command } from 'commander';

import { authedFetch, CliError, EXIT } from '../lib/http';
import { render } from '../lib/output';
import { fetchCurrentPage } from '../lib/page-write';
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
      return attachments.map((a) => `${a.originalName ?? a.fileName ?? '(unnamed)'}  ${a.url ?? ''}`.trimEnd()).join('\n');
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

  const form = new FormData();
  // Node 18+ globals: Blob / File / FormData. A Blob with a filename via the
  // 3rd FormData.append arg is sufficient for the multipart `file` field.
  const blob = new Blob([bytes]);
  form.append('file', blob, basename(file));

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

/** Register the `attach` command group (`list` / `add`). */
export function registerAttach(program: Command): void {
  const attach = program.command('attach').description('List or upload page attachments (needs attachments:* scope)');

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
}
