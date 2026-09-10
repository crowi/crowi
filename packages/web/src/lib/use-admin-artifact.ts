'use client';

import type { GetArtifactSettingsResponse, UpdateArtifactSettingsRequest } from '@crowi/api-contract';
import { m } from '@paraglide/messages.js';

import { apiClient } from './api-client';
import { createAdminSettingsHooks } from './admin-settings-factory';

export const adminArtifactKeys = {
  all: ['admin', 'artifact'] as const,
};

/**
 * feature-html-artifact-delivery-policy §A-4 — the one discriminated
 * failure `PUT /admin/artifact` can return: a same-origin toggle request
 * with no `CLIENT_URL` configured on the api. Kept as its own `Error`
 * subclass (mirrors `use-admin-plugins.ts`'s `PluginConfigValidationError` /
 * `LinkedIdentitiesExistError`) rather than a generic message string so a
 * future caller could branch on it — today `artifact-form.tsx` just
 * displays `.message` like any other thrown `Error`.
 */
export class ArtifactSettingsRejectedFailure extends Error {
  readonly code = 'ARTIFACT_SETTINGS_REJECTED' as const;
  readonly reason = 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactSettingsRejectedFailure';
  }
}

const hooks = createAdminSettingsHooks<GetArtifactSettingsResponse, UpdateArtifactSettingsRequest>({
  queryKey: adminArtifactKeys.all,
  fetch: () => apiClient.admin.artifact.$get(),
  update: (body) => apiClient.admin.artifact.$put({ json: body }),
  fetchErrorMessage: 'Failed to fetch artifact delivery settings',
  updateErrorMessage: 'Failed to update artifact delivery settings',
  mapValidationError: (body) => {
    if (body.error.code === 'ARTIFACT_SETTINGS_REJECTED' && body.error.reason === 'CLIENT_URL_REQUIRED_FOR_SAME_ORIGIN') {
      return new ArtifactSettingsRejectedFailure(m['admin.artifact.error_same_origin_requires_client_url']());
    }
    return null;
  },
});

export const useAdminArtifactSettings = hooks.useGet;
export const useUpdateAdminArtifactSettings = hooks.useUpdate;
