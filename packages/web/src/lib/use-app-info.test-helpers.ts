import type { AppInfoResponse } from '@crowi/api-contract';

/**
 * Shape returned by `useAppInfo()` — the slice components consume. Kept here
 * so test files can mock the hook with a typed value without re-encoding the
 * type at each call site.
 */
export type AppInfoQuery = {
  data?: AppInfoResponse;
  isLoading: boolean;
  isError: boolean;
};

/**
 * Build an `AppInfoResponse` for tests. Defaults to a "null instance" — no
 * title / confidential, version `0.0.0`, capability list empty — so callers
 * only override the bit they care about (most commonly `canSelfRegister`).
 *
 * vi.mock + vi.hoisted are file-scoped, so each test file still wires its own
 * `useAppInfo` mock. This helper just removes the boilerplate of typing the
 * response shape per file.
 */
export const makeAppInfo = (overrides: Partial<AppInfoResponse> = {}): AppInfoResponse => ({
  title: null,
  confidential: null,
  version: '0.0.0',
  apiVersion: 'v2',
  capabilities: [],
  canSelfRegister: true,
  rendererStylesheets: [],
  ...overrides,
});
