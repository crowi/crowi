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

export type { CrowiPlugin } from './plugin';

export type { PluginContext, AppInfo, PageMetadataAccessor, PluginLogger, StateCell } from './context';

export type { StorageDriver, StorageRegistry, StoragePutMeta, StoragePutResult } from './registries/storage';

export type {
  SearchDriver,
  SearchRegistry,
  SearchableDoc,
  SearchQuery,
  SearchQueryViewer,
  SearchQueryGrants,
  SearchPageType,
  SearchHits,
  SearchHit,
} from './registries/search';

export type { AuthDriver, AuthRegistry, AuthProfile, AuthVerifyResult } from './registries/auth';

export type { NotifierDriver, NotifierRegistry, NotificationPayload } from './registries/notifier';

export type { MailSender, MailSenderRegistry, EmailMessage } from './registries/mail';

export type {
  RendererRegistry,
  NodeRenderer,
  CodeBlockRenderer,
  CodeBlockInfo,
  EmbedRenderer,
  EmbedInput,
  EmbedFragment,
  UrlInlineExpansionRule,
  InlineExpansion,
  RenderContext,
  RenderPhase,
  RenderResult,
  RenderError,
  RenderActor,
  AdmissionControlConfig,
  Reservation,
  CacheStorage,
  ScopedCacheStorage,
  CacheKey,
  CacheEntry,
  AuthContext,
} from './renderer';

export type { EventBus, PluginEvents } from './events';

export type { PluginRouterScope, PluginRouteHandler, PluginRouteMethod, PluginRouteOptions } from './routes';

export { SENSITIVE_FIELD_MARKER, ACTION_FIELD_MARKER, isSensitiveField, getActionAnnotation } from './schema-markers';
