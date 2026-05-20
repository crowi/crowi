/**
 * Sanity fixture — a non-trivial plugin definition that exercises every
 * extension point and must compile against the public surface of
 * `@crowi/plugin-api`. This file is excluded from the published build
 * via the tsconfig `include` glob; it exists to fail type-check when
 * the contract regresses.
 *
 * Do not import from here at runtime.
 */

import { z } from 'zod/v3';
import { initContract } from '@ts-rest/core';
import type { CrowiPlugin } from '../plugin';

const c = initContract();

const exampleContract = c.router({
  testConnection: {
    method: 'POST' as const,
    path: '/test',
    body: z.object({}),
    responses: { 200: z.object({ ok: z.boolean() }) },
  },
});

const examplePlugin: CrowiPlugin = {
  name: '@crowi/example',
  version: '0.0.0',
  requires: [],

  configSchema: z.object({
    region: z.string().describe('AWS region (e.g. ap-northeast-1)'),
    secretAccessKey: z.string().describe('@sensitive AWS secret access key'),
    enabled: z.boolean(),
  }),

  pageMetadataSchema: z.object({
    channel: z.string().optional(),
  }),

  registerStorage: (registry, ctx) => {
    ctx.log.info('registering example storage driver');
    registry.register('example', {
      put: async (key, _body, _meta) => ({ key }),
      get: async (_key) => {
        throw new Error('not implemented');
      },
      delete: async (_key) => {},
    });
  },

  registerSearch: (registry, _ctx) => {
    registry.register('example', {
      index: async (_doc) => {},
      remove: async (_id) => {},
      query: async (_q) => ({ total: 0, hits: [] }),
    });
  },

  registerAuth: (registry, _ctx) => {
    registry.register('example', {
      buttonLabel: 'Sign in with Example',
      verify: async (_data) => ({ ok: false, reason: 'not implemented' }),
    });
  },

  registerNotifier: (registry, _ctx) => {
    registry.register('example', {
      send: async (_payload) => {},
    });
  },

  registerHooks: (events, ctx) => {
    events.on('page:created', (payload) => {
      ctx.log.info('page created', payload.path);
    });
  },

  registerRoutes: (scope, _ctx) => {
    scope.register(exampleContract, {
      testConnection: async () => ({ status: 200, body: { ok: true } }),
    });
  },

  onInstall: async (ctx) => {
    ctx.log.info('example plugin installed');
  },

  onUninstall: async (ctx) => {
    ctx.log.info('example plugin uninstalled');
  },
};

// Re-export to avoid "unused" warning. Pure type-checking fixture.
export { examplePlugin };
