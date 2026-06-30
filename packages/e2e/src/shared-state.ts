import fs from 'node:fs/promises';
import { sharedStatePath, type E2eSharedState } from './config';

export async function writeSharedState(state: E2eSharedState): Promise<void> {
  await fs.writeFile(sharedStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function readSharedState(): Promise<E2eSharedState> {
  const raw = await fs.readFile(sharedStatePath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<E2eSharedState>;
  if (!parsed.pageId || !parsed.pagePath) {
    throw new Error(`Invalid E2E shared state at ${sharedStatePath}`);
  }
  return { pageId: parsed.pageId, pagePath: parsed.pagePath };
}
