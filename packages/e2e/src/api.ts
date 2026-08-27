import type { BrowserContext } from '@playwright/test';
import { E2E_API_URL, E2E_WEB_URL, type E2eUserCredentials } from './config';

export async function accessTokenFromContext(context: BrowserContext): Promise<string> {
  const state = await context.storageState();
  const origin = state.origins.find((candidate) => candidate.origin === E2E_WEB_URL);
  const token = origin?.localStorage.find((entry) => entry.name === 'accessToken')?.value;
  if (!token) throw new Error(`No accessToken found in storageState for ${E2E_WEB_URL}`);
  return token;
}

export async function createPageViaApi(context: BrowserContext, input: { path: string; body: string; grant?: number }): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to create E2E page ${input.path}: HTTP ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { page?: { _id?: string; id?: string } };
  const pageId = body.page?._id ?? body.page?.id;
  if (!pageId) throw new Error(`Create page response did not include a page id: ${JSON.stringify(body)}`);
  return pageId;
}

/**
 * Upload a file attachment to a page as the user backing `context`
 * (`POST /api/pages/:pageId/attachments`, multipart). Returns the new
 * attachment's id and its canonical `url`
 * (`/api/attachments/<id>` — feature-image-derivative-optimization Phase 2:
 * this is the display-priority URL, NOT necessarily the original bytes).
 * Node 24's native `fetch`/`FormData`/`Blob` are used directly, the same way
 * `createPageViaApi` uses native `fetch` — no browser round-trip needed.
 */
export async function uploadAttachmentViaApi(
  context: BrowserContext,
  input: { pageId: string; fileName: string; contentType: string; data: Buffer },
): Promise<{ id: string; url: string }> {
  const accessToken = await accessTokenFromContext(context);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(input.data)], { type: input.contentType }), input.fileName);

  const response = await fetch(`${E2E_API_URL}/api/pages/${input.pageId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload E2E attachment to page ${input.pageId}: HTTP ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { attachment?: { _id?: string }; url?: string };
  const id = body.attachment?._id;
  const url = body.url;
  if (!id || !url) throw new Error(`Upload attachment response did not include an id/url: ${JSON.stringify(body)}`);
  return { id, url };
}

/**
 * Create many pages via `createPageViaApi`, in bounded-concurrency batches.
 * Used by pagination.spec.ts to seed enough siblings under one parent path
 * to trigger a real 2nd page — `Page.createPage` never auto-creates an
 * intermediate portal document, so concurrent siblings under the same
 * parent path are race-free.
 */
export async function createPagesViaApi(context: BrowserContext, inputs: Array<{ path: string; body: string }>, concurrency = 20): Promise<void> {
  for (let i = 0; i < inputs.length; i += concurrency) {
    const batch = inputs.slice(i, i + concurrency);
    await Promise.all(batch.map((input) => createPageViaApi(context, input)));
  }
}

/**
 * Invite a batch of users via `POST /api/admin/users/invite` with
 * `sendEmail: false`, so a test can cheaply seed dozens of `REGISTERED`
 * users (no Mailpit round trip) purely to trigger a real 2nd page in the
 * admin users list.
 */
export async function inviteUsersViaApi(context: BrowserContext, emails: string[]): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/users/invite`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ emailList: emails, sendEmail: false }),
  });

  if (!response.ok) {
    throw new Error(`Failed to invite E2E users: HTTP ${response.status} ${await response.text()}`);
  }
}

/** List currently-loaded plugin names via the admin API (`GET /api/admin/plugins`). */
export async function listLoadedPluginNamesViaApi(context: BrowserContext): Promise<string[]> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/plugins`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to list E2E plugins: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { plugins?: Array<{ name?: string }> };
  return (body.plugins ?? []).map((p) => p.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Update a plugin's config via the admin API
 * (`PUT /api/admin/plugins/config?name=<name>`) — merges `values` into
 * the plugin's existing config and, for a plugin that declares a
 * `reconfigure` hook, live-applies it (no restart needed) before this
 * resolves. feature-renderer-plugin-boundary Phase 2 — `renderer-plugins.
 * spec.ts` uses this to point the PlantUML plugin's `serverUrl` at the
 * compose-published `http://localhost:8080` server (spec §9); the same
 * generic endpoint `admin-mail-page.ts`'s UI-driven SMTP config flow PUTs
 * to, called directly here since the config FORM itself isn't what this
 * spec tests.
 */
export async function updatePluginConfigViaApi(context: BrowserContext, input: { pluginName: string; values: Record<string, unknown> }): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/admin/plugins/config?name=${encodeURIComponent(input.pluginName)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ values: input.values }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update E2E plugin config for ${input.pluginName}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { hotReloaded?: boolean; reconfigureFailed?: boolean };
  if (!body.hotReloaded) {
    throw new Error(
      `Update E2E plugin config for ${input.pluginName} did not hot-reload (reconfigureFailed=${body.reconfigureFailed}) — the api process may need a restart to see the new value.`,
    );
  }
}

/**
 * Read a page's current (latest) revision's `renderedAst` (the transformed
 * mdast the web client renders without re-parsing, RFC-0002 Phase 3) via
 * the API. feature-renderer-plugin-boundary Phase 2 — used to assert the
 * serialized AST carries real optional-renderer output (spec §9).
 */
export async function getPageRenderedAst(context: BrowserContext, pageId: string): Promise<unknown> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages?page_id=${encodeURIComponent(pageId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to read E2E page ${pageId}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { page?: { revision?: { renderedAst?: unknown } | string } };
  const revision = body.page?.revision;
  const renderedAst = typeof revision === 'string' ? undefined : revision?.renderedAst;
  if (renderedAst === undefined) throw new Error(`Get page response did not include renderedAst: ${JSON.stringify(body)}`);
  return renderedAst;
}

/**
 * Read a page's current (latest) revision id via the API. Needed to post
 * a comment, which references the revision it was written against.
 */
export async function getPageLatestRevisionId(context: BrowserContext, pageId: string): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages?page_id=${encodeURIComponent(pageId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to read E2E page ${pageId}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { page?: { revision?: { _id?: string } | string } };
  const revision = body.page?.revision;
  const revisionId = typeof revision === 'string' ? revision : revision?._id;
  if (!revisionId) throw new Error(`Get page response did not include a revision id: ${JSON.stringify(body)}`);
  return revisionId;
}

/**
 * Read a page's current (latest) revision BODY via the API, by page id
 * (works across a rename/soft-delete since `page_id` is stable and
 * `findPageByIdAndGrantedUser` does not filter on `status`/`path`).
 *
 * RFC-0017 Phase 1 — used to assert a stale collab save (attempted from a
 * pre-lifecycle-transition session) never landed as a new revision: the
 * persisted body must still equal whatever it was before the rename/delete.
 */
export async function getPageBody(context: BrowserContext, pageId: string): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages?page_id=${encodeURIComponent(pageId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to read E2E page ${pageId}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { page?: { revision?: { body?: string } | string } };
  const revision = body.page?.revision;
  const revisionBody = typeof revision === 'string' ? undefined : revision?.body;
  if (revisionBody === undefined) throw new Error(`Get page response did not include a revision body: ${JSON.stringify(body)}`);
  return revisionBody;
}

/**
 * Update an existing page's body as the user backing `context`
 * (`PUT /api/pages`). Looks up the current revision id itself so the
 * caller doesn't have to (the update is rejected with 409 if `revision_id`
 * is stale — reading it immediately before the call keeps this race-free
 * for the single-writer-at-a-time way e2e specs use it).
 */
export async function updatePageViaApi(context: BrowserContext, input: { pageId: string; body: string }): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const revisionId = await getPageLatestRevisionId(context, input.pageId);
  const response = await fetch(`${E2E_API_URL}/api/pages`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ page_id: input.pageId, body: input.body, revision_id: revisionId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update E2E page ${input.pageId}: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * A fresh key per call, matching what the built-in UI sends
 * (`crypto.randomUUID().replaceAll('-', '')` in `rename-dialog.tsx` /
 * `page-view.tsx`) and satisfying `IDEMPOTENCY_KEY_PATTERN`
 * (`^[A-Za-z0-9_-]{16,128}$`). Never reuse one across calls: replaying a key
 * with a different destination is refused with 409
 * `IDEMPOTENCY_KEY_CONFLICT`, and these helpers are called repeatedly with
 * different paths within a single spec.
 */
function freshIdempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * Rename a page as the user backing `context` (`POST /api/pages/rename`).
 * RFC-0017 Phase 1 — used to exercise the collab lifecycle epoch: a rename
 * must invalidate any live collab editor open on `pageId`, even though the
 * rename itself never touches `currentRevision`.
 *
 * `includeDescendants` triggers a subtree rename (`Page.renameTree`) —
 * AC-32/AC-39/AC-41's "subtree rename invalidates moved descendants" case:
 * each descendant is moved (and epoch-advanced + `page-renamed`-broadcast)
 * via its own per-page `Page.rename`, not just the root.
 */
export async function renamePageViaApi(context: BrowserContext, input: { pageId: string; newPath: string; includeDescendants?: boolean }): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages/rename`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': freshIdempotencyKey(),
    },
    body: JSON.stringify({ page_id: input.pageId, new_path: input.newPath, include_descendants: input.includeDescendants }),
  });
  if (!response.ok) {
    throw new Error(`Failed to rename E2E page ${input.pageId} to ${input.newPath}: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Soft-delete a page as the user backing `context` (`DELETE /api/pages`).
 * RFC-0017 Phase 1 — used to exercise the collab lifecycle epoch: a delete
 * must invalidate any live collab editor open on `pageId`.
 */
export async function deletePageViaApi(context: BrowserContext, input: { pageId: string }): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/pages`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': freshIdempotencyKey(),
    },
    body: JSON.stringify({ page_id: input.pageId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to delete E2E page ${input.pageId}: HTTP ${response.status} ${await response.text()}`);
  }
}

/** Post a comment as the user backing `context`. Returns the new comment id. */
export async function addCommentViaApi(context: BrowserContext, input: { pageId: string; revisionId: string; comment: string }): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ page_id: input.pageId, revision_id: input.revisionId, comment: input.comment }),
  });
  if (!response.ok) {
    throw new Error(`Failed to add E2E comment on ${input.pageId}: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { comment?: { _id?: string } };
  const commentId = body.comment?._id;
  if (!commentId) throw new Error(`Add comment response did not include a comment id: ${JSON.stringify(body)}`);
  return commentId;
}

/** Delete a comment as the user backing `context`. */
export async function deleteCommentViaApi(context: BrowserContext, input: { pageId: string; commentId: string }): Promise<void> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/comments`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ comment_id: input.commentId, page_id: input.pageId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to delete E2E comment ${input.commentId}: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Read `GET /api/installer` — the API's LIVE installed-state oracle
 * (`isAppInstalled` counts `{ ns: 'crowi' }` Config docs on every call, so
 * the answer can never be a boot-cache artifact of a reused webServer).
 *
 * Used by `onboarding.setup.ts` as a precondition check: the suite's
 * MongoDB reset runs in the `e2e` package script BEFORE `playwright test`
 * (see `playwright.config.ts`'s note on why it can't be a config-level
 * `globalSetup`), and a run is left INSTALLED when it finishes — so an
 * invocation that skips that reset step, or one that races another e2e
 * process over the shared ports/database, silently starts against an
 * already-installed instance.
 */
export async function getInstallerStatus(): Promise<'installer_required' | 'already_installed'> {
  const response = await fetch(`${E2E_API_URL}/api/installer`);
  if (!response.ok) {
    throw new Error(`Failed to read E2E installer status: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { status?: unknown };
  if (body.status !== 'installer_required' && body.status !== 'already_installed') {
    throw new Error(`Unexpected E2E installer status payload: ${JSON.stringify(body)}`);
  }
  return body.status;
}

export async function loginViaApi(credentials: E2eUserCredentials): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(`${E2E_API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (!response.ok) {
    throw new Error(`API login failed for ${credentials.email}: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
}
