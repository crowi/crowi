import Crowi from 'server/crowi'
import { Types, Document, Model, Schema, model } from 'mongoose'
import Debug from 'debug'

const SECURITY_REGISTRATION_MODE_OPEN = 'Open'
const SECURITY_REGISTRATION_MODE_RESTRICTED = 'Resricted'
const SECURITY_REGISTRATION_MODE_CLOSED = 'Closed'

interface Config {
  crowi: object
  notification: object
}

export interface ConfigDocument extends Document {
  _id: Types.ObjectId
  ns: string
  key: string
  value: string
}

export interface ConfigModel extends Model<ConfigDocument> {
  getRegistrationModeLabels(): Record<string, any>
  applicationInstall(): Promise<void>
  updateCache(ns: string, key: string, value: string): void
  updateCacheByNamespace(ns: string, nsConfig: Record<string, any>): void
  copyCache(ns: string, key: string, newKey: string): void
  deleteCache(ns: string, key: string): void
  updateByParams(ns: string, key: string, value: string): Promise<void>
  updateConfig(ns: string, key: string, value: string): Promise<void>
  updateConfigByNamespace(ns: string, nsConfig: Record<string, any>): Promise<void>
  copyByParams(ns: string, key: string, newKey: string): Promise<void>
  copyConfig(ns: string, key: string, newKey: string): Promise<void>
  deleteByParams(ns: string, key: string): Promise<void>
  deleteConfig(ns: string, key: string): Promise<void>
  loadAllConfig(): Promise<object>
  isRequiredThirdPartyAuth(config: Config): boolean
  isDisabledPasswordAuth(config: Config): boolean
  isUploadable(config: Config): boolean
  fileUploadEnabled(config: Config): boolean
  googleLoginEnabled(config: Config): boolean
  githubLoginEnabled(config: Config): boolean
  hasSlackConfig(config: Config): boolean
  hasSlackToken(config: Config): boolean
  getLocalconfig(config: Config): object
  migrate(): Promise<void>

  SECURITY_REGISTRATION_MODE_OPEN: string
  SECURITY_REGISTRATION_MODE_RESTRICTED: string
  SECURITY_REGISTRATION_MODE_CLOSED: string
}

export default (crowi: Crowi) => {
  const debug = Debug('crowi:models:config')

  const configSchema = new Schema<ConfigDocument, ConfigModel>({
    ns: { type: String, required: true, index: true },
    key: { type: String, required: true, index: true },
    value: { type: String, required: true },
  })

  function getArrayForInstalling() {
    return {
      // 'app:installed'     : "0.0.0",
      'app:title': 'Crowi',
      'app:confidential': '',

      'app:fileUpload': false,

      'app:externalShare': false,

      'security:registrationMode': 'Open',
      'security:registrationWhiteList': [],

      'auth:requireThirdPartyAuth': false,
      'auth:disablePasswordAuth': false,

      'upload:aws:bucket': 'crowi',
      'upload:aws:region': 'ap-northeast-1',
      'upload:aws:accessKeyId': '',
      'upload:aws:secretAccessKey': '',

      'mail:from': '',
      'mail:smtpHost': '',
      'mail:smtpPort': '',
      'mail:smtpUser': '',
      'mail:smtpPassword': '',
      'mail:aws:region': 'ap-northeast-1',
      'mail:aws:accessKeyId': '',
      'mail:aws:secretAccessKey': '',

      'google:clientId': '',
      'google:clientSecret': '',

      'github:clientId': '',
      'github:clientSecret': '',
      'github:organization': '',
    }
  }

  configSchema.statics.getRegistrationModeLabels = function() {
    return {
      [SECURITY_REGISTRATION_MODE_OPEN]: '公開 (だれでも登録可能)',
      [SECURITY_REGISTRATION_MODE_RESTRICTED]: '制限 (登録完了には管理者の承認が必要)',
      [SECURITY_REGISTRATION_MODE_CLOSED]: '非公開 (登録には管理者による招待が必要)',
    }
  }

  // Execute only once for installing application
  configSchema.statics.applicationInstall = async function() {
    const count = await Config.countDocuments({ ns: 'crowi' }).exec()
    if (count > 0) {
      throw new Error('Application already installed')
    }
    await Config.updateConfigByNamespace('crowi', getArrayForInstalling())
  }

  configSchema.statics.updateCache = function(ns, key, value) {
    const config = crowi.getConfig()

    if (!config[ns]) {
      config[ns] = {}
    }

    config[ns][key] = value

    crowi.setConfig(config)
  }

  configSchema.statics.copyCache = function(ns, key, newKey) {
    const config = crowi.getConfig()

    if (!config[ns]) {
      config[ns] = {}
    }

    if (config[ns][newKey] === undefined && config[ns][key] !== undefined) {
      config[ns][newKey] = config[ns][key]
      crowi.setConfig(config)
    }
  }

  configSchema.statics.deleteCache = function(ns, key) {
    const config = crowi.getConfig()

    if (!config[ns]) {
      config[ns] = {}
    }

    delete config[ns][key]

    crowi.setConfig(config)
  }

  configSchema.statics.updateCacheByNamespace = function(ns, nsConfig) {
    const config = crowi.getConfig()

    if (!config[ns]) {
      config[ns] = {}
    }

    Object.entries(nsConfig).forEach(([key, value]) => (config[ns][key] = value))

    crowi.setConfig(config)
  }

  configSchema.statics.updateByParams = async function(ns, key, value) {
    await Config.findOneAndUpdate({ ns, key }, { ns, key, value: JSON.stringify(value) }, { upsert: true }).exec()
  }

  configSchema.statics.updateConfig = async function(ns, key, value) {
    try {
      await Config.updateByParams(ns, key, value)
    } catch (err) {
      debug('updateConfig', err)
    }

    Config.updateCache(ns, key, value)
  }

  configSchema.statics.updateConfigByNamespace = async function(ns, nsConfig) {
    try {
      await Promise.all(Object.entries(nsConfig).map(([key, value]) => Config.updateByParams(ns, key, value)))
    } catch (err) {
      debug('updateConfigByNamespace', err)
    }

    Config.updateCacheByNamespace(ns, nsConfig)
  }

  configSchema.statics.copyByParams = async function(ns, key, newKey) {
    const config = await Config.findOne({ ns, key }).exec()
    if (config !== null) {
      await Config.findOneAndUpdate({ ns, key: newKey }, { ns, key: newKey, value: config.value }, { upsert: true }).exec()
    }
  }

  configSchema.statics.copyConfig = async function(ns, key, newKey) {
    try {
      await Config.copyByParams(ns, key, newKey)
    } catch (err) {
      debug('copyConfig', err)
    }

    Config.copyCache(ns, key, newKey)
  }

  configSchema.statics.deleteByParams = async function(ns, key) {
    await Config.deleteOne({ ns, key }).exec()
  }

  configSchema.statics.deleteConfig = async function(ns, key) {
    try {
      await Config.deleteByParams(ns, key)
    } catch (err) {
      debug('deleteConfig', err)
    }

    Config.deleteCache(ns, key)
  }

  configSchema.statics.loadAllConfig = async function() {
    const config = { crowi: {} }

    const doc = await Config.find()
      .sort({ ns: 1, key: 1 })
      .exec()

    doc.forEach(({ ns, key, value }) => {
      if (!config[ns]) {
        config[ns] = {}
      }

      config[ns][key] = JSON.parse(value)
    })

    return config
  }

  configSchema.statics.isRequiredThirdPartyAuth = function(config) {
    return !!config.crowi['auth:requireThirdPartyAuth']
  }

  configSchema.statics.isDisabledPasswordAuth = function(config) {
    return !!config.crowi['auth:disablePasswordAuth']
  }

  configSchema.statics.isUploadable = function(config) {
    const method = crowi.env.FILE_UPLOAD || 'aws'
    const isConfigured =
      config.crowi['upload:aws:accessKeyId'] &&
      config.crowi['upload:aws:secretAccessKey'] &&
      config.crowi['upload:aws:region'] &&
      config.crowi['upload:aws:bucket']

    if (method == 'aws' && !isConfigured) {
      return false
    }

    return method != 'none'
  }

  configSchema.statics.fileUploadEnabled = function(config) {
    if (!Config.isUploadable(config)) {
      return false
    }

    return config.crowi['app:fileUpload'] || false
  }

  configSchema.statics.googleLoginEnabled = function(config) {
    return config.crowi['google:clientId'] && config.crowi['google:clientSecret']
  }

  configSchema.statics.githubLoginEnabled = function(config) {
    return config.crowi['github:clientId'] && config.crowi['github:clientSecret']
  }

  configSchema.statics.hasSlackConfig = function(config) {
    if (!config.notification) {
      return false
    }
    if (!config.notification['slack:clientId'] || !config.notification['slack:clientSecret']) {
      return false
    }

    return true
  }

  configSchema.statics.hasSlackToken = function(config) {
    if (!this.hasSlackConfig(config)) {
      return false
    }

    if (!config.notification['slack:token']) {
      return false
    }

    return true
  }

  configSchema.statics.getLocalconfig = function(config) {
    const env = crowi.getEnv()

    const localConfig = {
      crowi: {
        title: config.crowi['app:title'],
        url: config.crowi['app:url'] || '',
        auth: {
          requireThirdPartyAuth: Config.isRequiredThirdPartyAuth(config),
          disablePasswordAuth: Config.isDisabledPasswordAuth(config),
        },
      },
      upload: {
        image: Config.isUploadable(config),
        file: Config.fileUploadEnabled(config),
      },
      env: {
        PLANTUML_URI: env.PLANTUML_URI || null,
        MATHJAX: env.MATHJAX || null,
      },
    }

    return localConfig
  }

  configSchema.statics.migrate = async function() {
    const renameKeys = {
      crowi: [
        ['aws:bucket', 'upload:aws:bucket'],
        ['aws:region', 'upload:aws:region'],
        ['aws:accessKeyId', 'upload:aws:accessKeyId'],
        ['aws:secretAccessKey', 'upload:aws:secretAccessKey'],
        ['aws:region', 'mail:aws:region'],
        ['aws:accessKeyId', 'mail:aws:accessKeyId'],
        ['aws:secretAccessKey', 'mail:aws:secretAccessKey'],
      ],
    }

    const forEachConfigs = (func: (ns: string, oldKey: string, newKey: string) => Promise<void>): Promise<void[][]> =>
      Promise.all(Object.entries(renameKeys).map(([ns, keys]) => Promise.all(keys.map(([oldKey, newKey]) => func(ns, oldKey, newKey)))))

    await forEachConfigs((ns, oldKey, newKey) => Config.copyConfig(ns, oldKey, newKey))
    await forEachConfigs((ns, oldKey) => Config.deleteConfig(ns, oldKey))
  }

  configSchema.statics.SECURITY_REGISTRATION_MODE_OPEN = SECURITY_REGISTRATION_MODE_OPEN
  configSchema.statics.SECURITY_REGISTRATION_MODE_RESTRICTED = SECURITY_REGISTRATION_MODE_RESTRICTED
  configSchema.statics.SECURITY_REGISTRATION_MODE_CLOSED = SECURITY_REGISTRATION_MODE_CLOSED

  const Config = model<ConfigDocument, ConfigModel>('Config', configSchema)

  return Config
}
