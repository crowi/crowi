/**
 * feature-core-config-readiness-and-mail — static declarations of CORE
 * (non-plugin) config that must be set before a feature the admin selected
 * can actually work, mirroring a plugin's own `readiness` declaration
 * (`PluginReadinessDeclaration`, `@crowi/plugin-api`) but for keys that
 * live directly in the `crowi` core config namespace (`Config` model, see
 * `packages/api/src/models/config.ts`) rather than a `plugin:<name>:*`
 * namespace.
 *
 * Unlike a plugin's `readiness`, a core declaration has no "selected
 * driver" gate — it always applies. `PluginManager.getReadinessIssues()`
 * evaluates every entry here against the live core config namespace,
 * using the same empty-value rule as plugin readiness
 * (`isReadinessFieldConfigured()`).
 *
 * `label` / `href` are plain display metadata copied straight through to
 * the wire `ConfigReadinessIssue` by the admin plugins handler — no
 * HTTP-layer knowledge lives here or in the manager.
 */

/** One core config field a declaration requires to be non-empty. */
export interface CoreReadinessDeclarationField {
  /** Display field name, echoed to the wire response `fields[].name`. */
  name: string;
  /** The core `crowi` namespace config key this field reads (e.g. `'mail:from'`). */
  configKey: string;
}

export interface CoreReadinessDeclaration {
  /** Stable id, namespaced with `core:` so it can never collide with a `plugin:<name>` issue id. */
  id: string;
  /** Display label for the banner / admin UI. */
  label: string;
  /** Admin path the issue links to (e.g. `/admin/mail`). Relative, within the admin shell. */
  href: string;
  fields: CoreReadinessDeclarationField[];
}

/**
 * The only declaration today is `mail:from` — the sender-independent
 * address required for mail to work at all, regardless of which sender
 * driver is selected (see `packages/api/src/service/mail.ts#getFrom`).
 * Future core features add entries here rather than growing a
 * mail-specific branch in the manager.
 */
export const CORE_READINESS_DECLARATIONS: readonly CoreReadinessDeclaration[] = [
  {
    id: 'core:mail',
    label: 'Mail',
    href: '/admin/mail',
    fields: [{ name: 'from', configKey: 'mail:from' }],
  },
];
