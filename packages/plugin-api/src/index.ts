/**
 * @crowi/plugin-api — type-only contract for Crowi 2.0 plugins.
 *
 * Plugins author against this package. The runtime (@crowi/server) loads
 * plugins listed in `crowi.config.json`, calls each plugin's
 * `register*` callbacks, and routes all the side effects (storage,
 * search, auth, notifications) through the typed registries declared
 * here.
 *
 * For the design rationale see `docs/rfcs/0001-plugin-architecture.md`
 * in the Crowi monorepo.
 */

export type { AppInfo, PageMetadataAccessor, PluginContext, PluginLogger, StateCell } from './context';
export type { EventBus, PluginEvents } from './events';
export { escapeHtml } from './html';
export type { CrowiPlugin, PluginReadinessDeclaration } from './plugin';

export type { AuthDriver, AuthProfile, AuthRegistry, AuthVerifyResult } from './registries/auth';
export type { EmailMessage, MailSender, MailSenderRegistry } from './registries/mail';
export type { NotificationPayload, NotifierDriver, NotifierRegistry } from './registries/notifier';
export type {
  SearchableDoc,
  SearchDriver,
  SearchHit,
  SearchHits,
  SearchPageType,
  SearchQuery,
  SearchQueryGrants,
  SearchQueryViewer,
  SearchRegistry,
} from './registries/search';
export type { StorageDriver, StoragePutMeta, StoragePutResult, StorageRegistry } from './registries/storage';
export type {
  AdmissionControlConfig,
  AuthContext,
  CacheEntry,
  CacheKey,
  CacheStorage,
  CodeBlockInfo,
  CodeBlockRenderer,
  EmbedFragment,
  EmbedInput,
  EmbedRenderer,
  InlineExpansion,
  NodeRenderer,
  RenderActor,
  RenderContext,
  RenderError,
  RendererRegistry,
  RenderPhase,
  RenderResult,
  Reservation,
  ScopedCacheStorage,
  StructuredRenderPayload,
  UrlInlineExpansionRule,
} from './renderer';
export type { PluginRouteHandler, PluginRouteMethod, PluginRouteOptions, PluginRouterScope } from './routes';
export { ACTION_FIELD_MARKER, getActionAnnotation, isSensitiveField, SENSITIVE_FIELD_MARKER } from './schema-markers';
export { extractSvgDimensions, sanitizeSvg } from './svg';
export type { SanitizeSvgPolicy, SanitizeSvgResult } from './svg';
