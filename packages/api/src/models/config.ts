import Crowi from 'src/crowi';
import { Types, Document, Model, Schema, model } from 'mongoose';
import Debug from 'debug';
import { decrypt, encrypt, isEncrypted, isEncryptionConfigured } from 'src/util/crypto';
import { isSensitiveConfig } from './config-sensitive';

const SECURITY_REGISTRATION_MODE_OPEN = 'Open';
const SECURITY_REGISTRATION_MODE_RESTRICTED = 'Resricted';
const SECURITY_REGISTRATION_MODE_CLOSED = 'Closed';

interface Config {
  crowi: object;
  notification: object;
}

export interface ConfigDocument extends Document {
  _id: Types.ObjectId;
  ns: string;
  key: string;
  value: string;
}

export const registrationMode: Record<string, any> = {
  [SECURITY_REGISTRATION_MODE_OPEN]: 'open',
  [SECURITY_REGISTRATION_MODE_RESTRICTED]: 'restricted',
  [SECURITY_REGISTRATION_MODE_CLOSED]: 'closed',
};

export function isRequiredThirdPartyAuth(config: Config): boolean {
  return !!config.crowi['auth:requireThirdPartyAuth'];
}

/**
 * RFC-0014 phase 4 — the physical Config key an atomic plugin config group
 * is stored under (`CrowiPlugin.configAtomicGroups`). The `__atomic:`
 * infix keeps it out of the ordinary `plugin:<name>:<field>` space, so a
 * plugin can never declare a field that collides with a group document.
 *
 * This key exists only at the storage layer: `loadAllConfig` expands the
 * group back into flat fields, so plugin code and the admin form never see
 * it.
 */
export function atomicConfigGroupKey(pluginName: string, groupName: string): string {
  return `plugin:${pluginName}:__atomic:${groupName}`;
}

/** The stored shape of an atomic group — every declared key, together, as one value. */
export type AtomicConfigGroupValue = Record<string, string>;

const ATOMIC_CONFIG_KEY_RE = /^plugin:(.+):__atomic:([^:]+)$/;

export function isDisabledPasswordAuth(config: Config): boolean {
  return !!config.crowi['auth:disablePasswordAuth'];
}

export function googleLoginEnabled(config: Config): boolean {
  return config.crowi['google:clientId'] && config.crowi['google:clientSecret'];
}

export function githubLoginEnabled(config: Config): boolean {
  return config.crowi['github:clientId'] && config.crowi['github:clientSecret'];
}

export function hasSlackConfig(config: Config): boolean {
  if (!config.notification) {
    return false;
  }
  if (!config.notification['slack:clientId'] || !config.notification['slack:clientSecret']) {
    return false;
  }

  return true;
}

export function hasSlackToken(config: Config): boolean {
  if (!hasSlackConfig(config)) {
    return false;
  }

  if (!config.notification['slack:token']) {
    return false;
  }

  return true;
}

export interface ConfigModel extends Model<ConfigDocument> {
  applicationInstall(): Promise<void>;
  updateByParams(ns: string, key: string, value: string): Promise<void>;
  /** RFC-0014 phase 4 — write a whole `configAtomicGroups` group as one document. Throws on failure, because callers must not proceed on an unpersisted value — the same contract `updateConfig` now has for a single key. */
  updateAtomicConfigGroup(ns: string, pluginName: string, groupName: string, values: AtomicConfigGroupValue): Promise<void>;
  updateConfig(ns: string, key: string, value: string): Promise<void>;
  updateConfigByNamespace(ns: string, nsConfig: Record<string, any>): Promise<void>;
  deleteByParams(ns: string, key: string): Promise<void>;
  deleteConfig(ns: string, key: string): Promise<void>;
  loadAllConfig(): Promise<object>;
  isUploadable(): boolean;

  SECURITY_REGISTRATION_MODE_OPEN: string;
  SECURITY_REGISTRATION_MODE_RESTRICTED: string;
  SECURITY_REGISTRATION_MODE_CLOSED: string;
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:config');

  const configSchema = new Schema<ConfigDocument, ConfigModel>({
    ns: { type: String, required: true, index: true },
    key: { type: String, required: true, index: true },
    value: { type: String, required: true },
  });

  function getArrayForInstalling() {
    return {
      // 'app:installed'     : "0.0.0",
      'app:title': 'Crowi',
      'app:confidential': '',
      'app:setupChecklistDismissed': false,

      'security:registrationMode': 'Open',
      'security:registrationWhiteList': [],

      'auth:requireThirdPartyAuth': false,
      'auth:disablePasswordAuth': false,

      // Storage credentials (incl. AWS) live in the storage plugin's own
      // config namespace (`plugin:@crowi/plugin-aws:*` /
      // `plugin:@crowi/plugin-storage-*:*`), entered via the admin Plugins
      // screen — not seeded here.

      // The sender-independent "from" address stays in core config; each
      // sender's transport credentials (SMTP host/auth, Resend API key,
      // SES via @crowi/plugin-aws) live in their plugin's config
      // namespace (`plugin:@crowi/plugin-mail-*:*`).
      'mail:from': '',

      // Google / GitHub social-login credentials are no longer seeded:
      // third-party sign-in was removed from core in the 2.0.0-alpha line and
      // will return as an auth provider plugin. The `googleLoginEnabled` /
      // `githubLoginEnabled` readers below are kept (they now always return
      // false) because dormant `User` methods still reference them.
    };
  }

  // Execute only once for installing application
  configSchema.statics.applicationInstall = async function () {
    const count = await Config.countDocuments({ ns: 'crowi' }).exec();
    if (count > 0) {
      throw new Error('Application already installed');
    }
    try {
      await Config.updateConfigByNamespace('crowi', getArrayForInstalling());
    } catch (err) {
      // The count check above guarantees `{ ns: 'crowi' }` was empty
      // before this call, so every row now present under that namespace
      // was written by this failed seeding attempt — deleting the whole
      // namespace can't destroy pre-existing data. Without this, a
      // partially-written seeding batch leaves rows behind that make
      // `isAppInstalled` report `already_installed` forever, even though
      // install never actually completed.
      try {
        await Config.deleteMany({ ns: 'crowi' }).exec();
      } catch (deleteErr) {
        debug('applicationInstall: failed to remove partially seeded crowi config:', (deleteErr as Error).message);
      }
      throw err;
    }
  };

  configSchema.statics.updateByParams = async function (ns: string, key: string, value: string) {
    let serialized = JSON.stringify(value);
    // Encrypt at rest for sensitive entries when a key is configured. Without
    // a key we silently fall back to plaintext (legacy behaviour) so missing
    // CROWI_ENCRYPTION_KEY never blocks an admin save.
    if (isSensitiveConfig(ns, key) && isEncryptionConfigured()) {
      serialized = encrypt(serialized);
    }
    await Config.findOneAndUpdate({ ns, key }, { ns, key, value: serialized }, { upsert: true }).exec();
  };

  /**
   * RFC-0014 phase 4 — write one atomic config group as a SINGLE document.
   *
   * Built on `updateByParams`, same as `updateConfig` now is: the whole
   * point of a group is that a failed write must be visible to the caller
   * so nothing downstream — in-memory config, listeners, Redis publish —
   * proceeds on a value that was never persisted.
   */
  configSchema.statics.updateAtomicConfigGroup = async function (ns: string, pluginName: string, groupName: string, values: AtomicConfigGroupValue) {
    await Config.updateByParams(ns, atomicConfigGroupKey(pluginName, groupName), values as unknown as string);
  };

  // Deliberately no try/catch: a rejection here must reach the caller so
  // ConfigService never mutates in-memory config, notifies listeners, or
  // publishes to Redis for a value the database does not hold.
  configSchema.statics.updateConfig = async function (ns: string, key: string, value: string) {
    await Config.updateByParams(ns, key, value);
  };

  // `Promise.allSettled`, not `Promise.all`: every key's write must reach
  // its own resolution before this can throw, otherwise a rejection races
  // ahead of in-flight siblings and the caller observes an indeterminate
  // DB state (some keys still mid-write) at the moment the error surfaces.
  // Waiting for full settlement makes the DB state final and observable by
  // the time the rejection propagates. Only the first rejection is thrown
  // — callers only ever collapse this to a 500 and never inspect the rest.
  configSchema.statics.updateConfigByNamespace = async function (ns: string, nsConfig: Record<string, any>) {
    const results = await Promise.allSettled(Object.entries(nsConfig).map(([key, value]) => Config.updateByParams(ns, key, value)));
    const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstRejection) {
      throw firstRejection.reason;
    }
  };

  configSchema.statics.deleteByParams = async function (ns, key) {
    await Config.deleteOne({ ns, key }).exec();
  };

  configSchema.statics.deleteConfig = async function (ns, key) {
    try {
      await Config.deleteByParams(ns, key);
    } catch (err) {
      debug('deleteConfig', err);
    }
  };

  configSchema.statics.loadAllConfig = async function () {
    const config = { crowi: {} };

    const doc = await Config.find().sort({ ns: 1, key: 1 }).exec();

    doc.forEach(({ ns, key, value }) => {
      if (!config[ns]) {
        config[ns] = {};
      }

      // Encrypted values carry our prefix; everything else (legacy plaintext
      // and ordinary settings) is parsed as-is. decrypt() throws on tampered
      // ciphertext but is a no-op for non-prefixed values.
      const raw = isEncrypted(value) ? decrypt(value) : value;
      const parsed = JSON.parse(raw);

      // RFC-0014 phase 4 — expand an atomic group document back into the
      // flat fields everything upstream expects, and never expose the
      // group key itself as runtime config.
      const atomicMatch = ATOMIC_CONFIG_KEY_RE.exec(key);
      if (atomicMatch) {
        const [, pluginName, groupName] = atomicMatch;
        // Refuse to boot on a malformed payload rather than degrade to a
        // partial expansion: silently dropping half a credential pair is
        // exactly the half-configured state this storage shape exists to
        // make impossible.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`Config: atomic group '${groupName}' of plugin '${pluginName}' is not a JSON object`);
        }
        for (const [field, fieldValue] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof fieldValue !== 'string') {
            throw new Error(`Config: atomic group '${groupName}' of plugin '${pluginName}' has a non-string value for '${field}'`);
          }
          config[ns][`plugin:${pluginName}:${field}`] = fieldValue;
        }
        return;
      }

      config[ns][key] = parsed;
    });

    return config;
  };

  // True iff a storage driver is registered for the active plugin
  // configuration. The driver itself owns "is the bucket configured /
  // is the path writable" — Config no longer reaches into AWS keys.
  configSchema.statics.isUploadable = function () {
    return crowi.getPlugins().active.storage !== null;
  };

  const Config = model<ConfigDocument, ConfigModel>('Config', configSchema);

  // 静的プロパティをスキーマではなくモデルに直接割り当て
  Config.SECURITY_REGISTRATION_MODE_OPEN = SECURITY_REGISTRATION_MODE_OPEN as string;
  Config.SECURITY_REGISTRATION_MODE_RESTRICTED = SECURITY_REGISTRATION_MODE_RESTRICTED as string;
  Config.SECURITY_REGISTRATION_MODE_CLOSED = SECURITY_REGISTRATION_MODE_CLOSED as string;

  return Config;
};
