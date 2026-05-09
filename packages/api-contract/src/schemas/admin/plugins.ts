import { z } from 'zod';

/**
 * Wire-shape of a single plugin config field. Mirrors the runtime
 * `SerializedPluginField` produced by `schema-serializer.ts`. The
 * admin form picks an input control based on `kind`.
 */
export const PluginFieldSchema = z.object({
  name: z.string(),
  kind: z.enum(['string', 'secret', 'number', 'boolean', 'enum', 'string-array']),
  description: z.string().optional(),
  defaultValue: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  action: z
    .object({
      label: z.string(),
      method: z.string(),
      path: z.string(),
    })
    .optional(),
  optional: z.boolean(),
});
export type PluginField = z.infer<typeof PluginFieldSchema>;

export const AdminSidebarSection = z.enum(['settings', 'shared', 'storage', 'mail', 'notification', 'auth']);
export type AdminSidebarSectionValue = z.infer<typeof AdminSidebarSection>;

export const PluginAdminPlacementSchema = z.object({
  /**
   * Sidebar section to surface this plugin under. The runtime fills
   * this in — it's either declared by the plugin via `adminPlacement`
   * or derived from its `register*` hooks. Plugins that fall through
   * with no inferable section default to `'settings'`.
   */
  section: AdminSidebarSection,
  /** Display label (defaults to the plugin's npm name). */
  label: z.string(),
  /** Lucide icon name from a fixed allow-list. */
  icon: z.string().optional(),
});
export type PluginAdminPlacement = z.infer<typeof PluginAdminPlacementSchema>;

export const PluginInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  requires: z.array(z.string()).optional(),
  /** Has a configSchema (= showable config form). */
  hasConfig: z.boolean(),
  /**
   * Driver-registry slots this plugin currently fills. Useful for the
   * admin "this plugin is the active storage driver" badge.
   */
  registers: z.array(z.string()),
  /**
   * Where the plugin appears in the admin sidebar. The server always
   * populates this even when the plugin didn't declare its own
   * `adminPlacement`.
   */
  adminPlacement: PluginAdminPlacementSchema,
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const ListPluginsResponseSchema = z.object({
  plugins: z.array(PluginInfoSchema),
});
export type ListPluginsResponse = z.infer<typeof ListPluginsResponseSchema>;

/**
 * Per-plugin config + form schema. Sensitive fields appear in
 * `values` as `{ hasValue: boolean }` — the plaintext is never
 * echoed back from the server.
 */
export const PluginConfigResponseSchema = z.object({
  name: z.string(),
  fields: z.array(PluginFieldSchema),
  values: z.record(z.unknown()),
});
export type PluginConfigResponse = z.infer<typeof PluginConfigResponseSchema>;

/**
 * Body for PUT plugin config. Each key in `values` must exist in the
 * plugin's schema; unknown keys are rejected. For sensitive fields:
 *   - undefined / missing → leave existing value untouched
 *   - empty string         → clear the saved value
 *   - non-empty string     → replace and re-encrypt
 */
export const UpdatePluginConfigRequestSchema = z.object({
  values: z.record(z.unknown()),
});
export type UpdatePluginConfigRequest = z.infer<typeof UpdatePluginConfigRequestSchema>;

export const UpdatePluginConfigResponseSchema = z.object({
  ok: z.literal(true),
});
export type UpdatePluginConfigResponse = z.infer<typeof UpdatePluginConfigResponseSchema>;

export const PluginNotFoundErrorSchema = z.object({
  error: z.object({
    code: z.literal('PLUGIN_NOT_FOUND'),
    message: z.string(),
  }),
});
export type PluginNotFoundError = z.infer<typeof PluginNotFoundErrorSchema>;

export const PluginConfigValidationErrorSchema = z.object({
  error: z.object({
    code: z.literal('PLUGIN_CONFIG_VALIDATION_FAILED'),
    message: z.string(),
    issues: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    ),
  }),
});
export type PluginConfigValidationError = z.infer<typeof PluginConfigValidationErrorSchema>;
