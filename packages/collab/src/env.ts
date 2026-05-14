/**
 * Centralised env-var resolution for the collab process. Kept in one
 * module so the surface that the Hocuspocus host depends on is easy to
 * spot and override in tests.
 *
 * The collab process is intentionally minimal: it does **not** boot the
 * Crowi class, does **not** call setupConfig, and does **not** read
 * MongoDB-stored config. Every runtime knob comes from env so cross-
 * process distribution is trivial (same .env file shared by api +
 * collab in dev, same env block in production).
 */

/**
 * Mirror the api package's `MONGO_URI` resolution order so dev `.env`
 * files written for @crowi/api work unchanged when collab is added to
 * the dev triplet. See packages/api/src/crowi/index.ts:setupDatabase.
 */
const DEFAULT_MONGO_URI = 'mongodb://localhost/crowi';

const resolveMongoUri = (env: NodeJS.ProcessEnv = process.env): string =>
  env.MONGOLAB_URI ?? env.MONGODB_URI ?? env.MONGOHQ_URL ?? env.MONGO_URI ?? DEFAULT_MONGO_URI;

export interface CollabEnv {
  /** Port the Hocuspocus HTTP/WebSocket server binds on. */
  port: number;
  /** Bind address. `0.0.0.0` so docker port-forward and LAN access work. */
  address: string;
  /** MongoDB connection string — must match @crowi/api so model state lines up. */
  mongoUri: string;
  /**
   * `true` when the collab process should run silently (production
   * default). `quiet` is forwarded to Hocuspocus's start screen.
   */
  quiet: boolean;
}

export function loadCollabEnv(env: NodeJS.ProcessEnv = process.env): CollabEnv {
  const portRaw = env.COLLAB_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3302;
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`[crowi:collab] COLLAB_PORT='${portRaw}' is not a valid TCP port number.`);
  }
  return {
    port,
    address: env.COLLAB_HOST ?? '0.0.0.0',
    mongoUri: resolveMongoUri(env),
    quiet: env.NODE_ENV === 'production',
  };
}
