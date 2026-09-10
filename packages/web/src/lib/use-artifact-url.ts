'use client';

import type { ArtifactUrlUnavailableError as ArtifactUrlUnavailableBody, MintArtifactUrlResponse } from '@crowi/api-contract';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from './api-client';
import { errorMessage } from './error-message';

/**
 * A `mutationKey`, not a query cache key — minting is a mutation:
 * `ArtifactView`'s explicit "run" action must always hit the network, never
 * be served from a `useQuery` cache. Kept for the same discoverability
 * reason every other `xxxKeys` factory exists (devtools, `useMutationState`
 * filtering).
 */
export const artifactUrlKeys = {
  all: ['artifact-url'] as const,
};

interface MintArtifactUrlVariables {
  pageId: string;
  revisionId?: string;
}

type ArtifactUrlUnavailableReason = ArtifactUrlUnavailableBody['error']['reason'];

/**
 * Thrown when the mint route's failure is the structured
 * `ARTIFACT_URL_UNAVAILABLE` envelope — `reason` lets the caller distinguish
 * "this revision isn't an artifact" from "delivery isn't configured on this
 * server", which render different UI. Every other failure (network error,
 * 401/403/404/500) surfaces as a plain `Error` with a fixed, localized
 * message instead.
 */
export class ArtifactUrlUnavailableFailure extends Error {
  readonly reason: ArtifactUrlUnavailableReason;

  constructor(reason: ArtifactUrlUnavailableReason, message: string) {
    super(message);
    this.name = 'ArtifactUrlUnavailableFailure';
    this.reason = reason;
  }
}

/**
 * Mints a signed, revision-scoped delivery URL for an HTML artifact page.
 * Always a fresh network call — tokens expire in 60s, so a cached response
 * would be useless before it could ever be reused.
 */
export function useMintArtifactUrl() {
  return useMutation({
    mutationKey: artifactUrlKeys.all,
    // A successful response carries a live signed URL/token. TanStack
    // Query's `MutationCache` defaults to a 5-minute `gcTime`, which would
    // keep that value readable from `queryClient.getMutationCache()` long
    // after `ArtifactView` clears its own `runningUrl` state. `gcTime: 0`
    // makes the mutation (and its data) eligible for removal as soon as the
    // last observer detaches, which `ArtifactView` triggers by calling
    // `reset()` on stop and on revision change.
    gcTime: 0,
    mutationFn: async ({ pageId, revisionId }: MintArtifactUrlVariables): Promise<MintArtifactUrlResponse> => {
      const response = await apiClient.pages[':id']['artifact-url'].$post({
        param: { id: pageId },
        json: revisionId !== undefined ? { revisionId } : {},
      });
      if (response.ok) {
        return response.json();
      }
      const body = await response.json().catch(() => null);
      const error = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: string; reason?: string } }).error : undefined;
      if (error?.code === 'ARTIFACT_URL_UNAVAILABLE' && (error.reason === 'NOT_AN_ARTIFACT' || error.reason === 'ARTIFACT_DELIVERY_NOT_CONFIGURED')) {
        throw new ArtifactUrlUnavailableFailure(error.reason, errorMessage(error.code));
      }
      // Never surface the server's raw `message` here — only fixed,
      // localized failure text reaches the UI.
      throw new Error(errorMessage(error?.code));
    },
  });
}
