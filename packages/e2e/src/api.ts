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
