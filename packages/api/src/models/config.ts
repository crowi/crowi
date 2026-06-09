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

      'google:clientId': '',
      'google:clientSecret': '',

      'github:clientId': '',
      'github:clientSecret': '',
      'github:organization': '',
    };
  }

  // Execute only once for installing application
  configSchema.statics.applicationInstall = async function () {
    const count = await Config.countDocuments({ ns: 'crowi' }).exec();
    if (count > 0) {
      throw new Error('Application already installed');
    }
    await Config.updateConfigByNamespace('crowi', getArrayForInstalling());
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

  configSchema.statics.updateConfig = async function (ns: string, key: string, value: string) {
    try {
      await Config.updateByParams(ns, key, value);
    } catch (err) {
      debug('updateConfig', err);
    }
  };

  configSchema.statics.updateConfigByNamespace = async function (ns: string, nsConfig: Record<string, any>) {
    try {
      await Promise.all(Object.entries(nsConfig).map(([key, value]) => Config.updateByParams(ns, key, value)));
    } catch (err) {
      debug('updateConfigByNamespace', err);
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
      config[ns][key] = JSON.parse(raw);
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
