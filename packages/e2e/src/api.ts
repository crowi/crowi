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
  const response = await fetch(`${E2E_API_URL}/api/v2/pages`, {
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
 * Read a page's current (latest) revision id via the API. Needed to post
 * a comment, which references the revision it was written against.
 */
export async function getPageLatestRevisionId(context: BrowserContext, pageId: string): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/v2/pages?page_id=${encodeURIComponent(pageId)}`, {
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

/** Post a comment as the user backing `context`. Returns the new comment id. */
export async function addCommentViaApi(context: BrowserContext, input: { pageId: string; revisionId: string; comment: string }): Promise<string> {
  const accessToken = await accessTokenFromContext(context);
  const response = await fetch(`${E2E_API_URL}/api/v2/comments`, {
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
  const response = await fetch(`${E2E_API_URL}/api/v2/comments`, {
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

export async function loginViaApi(credentials: E2eUserCredentials): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(`${E2E_API_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (!response.ok) {
    throw new Error(`API login failed for ${credentials.email}: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
}
