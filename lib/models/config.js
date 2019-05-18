module.exports = function(crowi) {
  const mongoose = require('mongoose')
  const debug = require('debug')('crowi:models:config')
  const configSchema = new mongoose.Schema({
    ns: { type: String, required: true, index: true },
    key: { type: String, required: true, index: true },
    value: { type: String, required: true },
  })
  const SECURITY_REGISTRATION_MODE_OPEN = 'Open'
  const SECURITY_REGISTRATION_MODE_RESTRICTED = 'Resricted'
  const SECURITY_REGISTRATION_MODE_CLOSED = 'Closed'

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

      'aws:bucket': 'crowi',
      'aws:region': 'ap-northeast-1',
      'aws:accessKeyId': '',
      'aws:secretAccessKey': '',

      'mail:from': '',
      'mail:smtpHost': '',
      'mail:smtpPort': '',
      'mail:smtpUser': '',
      'mail:smtpPassword': '',

      'google:clientId': '',
      'google:clientSecret': '',

      'github:clientId': '',
      'github:clientSecret': '',
      'github:organization': '',
    }
  }

  configSchema.statics.getRegistrationModeLabels = function() {
    return {
      SECURITY_REGISTRATION_MODE_OPEN: '公開 (だれでも登録可能)',
      SECURITY_REGISTRATION_MODE_RESTRICTED: '制限 (登録完了には管理者の承認が必要)',
      SECURITY_REGISTRATION_MODE_CLOSED: '非公開 (登録には管理者による招待が必要)',
    }
  }

  configSchema.statics.updateCache = function(ns, config) {
    var originalConfig = crowi.getConfig()
    var newNSConfig = originalConfig[ns] || {}
    Object.keys(config).forEach(function(key) {
      if (config[key] || config[key] === '' || config[key] === false) {
        newNSConfig[key] = config[key]
      }
    })

    originalConfig[ns] = newNSConfig
    crowi.setConfig(originalConfig)
  }

  // Execute only once for installing application
  configSchema.statics.applicationInstall = function(callback) {
    const Config = this
    Config.count({ ns: 'crowi' }, function(err, count) {
      if (count > 0) {
        return callback(new Error('Application already installed'), null)
      }
      try {
        return callback(Config.updates('crowi', getArrayForInstalling()), null)
      } catch (err) {
        return callback(err, null)
      }
    })
  }

  configSchema.statics.setupCofigFormData = function(ns, config) {
    var defaultConfig = {}
    if (ns === 'crowi') {
      defaultConfig = getArrayForInstalling()
    }
    if (!defaultConfig[ns]) {
      defaultConfig[ns] = {}
    }
    Object.keys(config[ns] || {}).forEach(function(key) {
      if (config[ns][key]) {
        defaultConfig[key] = config[ns][key]
      }
    })
    return defaultConfig
  }

  configSchema.statics.updates = function(ns, configs) {
    const Config = this
    if (configs.length < 0) {
      throw Error('Argument #1 is not array.')
    }

    Object.entries(configs).map(([key, value]) => {
      Config.update(ns, key, value)
    })

    Config.updateCache(ns, configs)

    return configs
  }

  configSchema.statics.update = async function(ns, key, value) {
    const Config = this
    try {
      const config = await Config.findOneAndUpdate({ ns, key }, { ns, key, value: JSON.stringify(value) }, { upsert: true }).exec()
      debug('Config.update', config)

      return config
    } catch (err) {
      debug('Config.update', err)

      throw err
    }
  }

  configSchema.statics.getConfig = function(callback) {}

  configSchema.statics.loadAllConfig = function(callback) {
    const Config = this
    const config = {
      crowi: {}, // crowi namespace
    }

    Config.find()
      .sort({ ns: 1, key: 1 })
      .exec(function(err, doc) {
        doc.forEach(function(el) {
          if (!config[el.ns]) {
            config[el.ns] = {}
          }
          config[el.ns][el.key] = JSON.parse(el.value)
        })

        debug('Config loaded', config)
        return callback(null, config)
      })
  }

  configSchema.statics.isRequiredThirdPartyAuth = function(config) {
    return !!config.crowi['auth:requireThirdPartyAuth']
  }

  configSchema.statics.isDisabledPasswordAuth = function(config) {
    return !!config.crowi['auth:disablePasswordAuth']
  }

  configSchema.statics.isUploadable = function(config) {
    var method = crowi.env.FILE_UPLOAD || 'aws'

    if (
      method == 'aws' &&
      (!config.crowi['aws:accessKeyId'] || !config.crowi['aws:secretAccessKey'] || !config.crowi['aws:region'] || !config.crowi['aws:bucket'])
    ) {
      return false
    }

    return method != 'none'
  }

  configSchema.statics.fileUploadEnabled = function(config) {
    const Config = this

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
    const Config = this
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

  /*
  configSchema.statics.isInstalled = function(config)
  {
    if (!config.crowi) {
      return false;
    }

    if (config.crowi['app:installed']
       && config.crowi['app:installed'] !== '0.0.0') {
      return true;
    }

    return false;
  }
  */

  configSchema.statics.SECURITY_REGISTRATION_MODE_OPEN = SECURITY_REGISTRATION_MODE_OPEN
  configSchema.statics.SECURITY_REGISTRATION_MODE_RESTRICTED = SECURITY_REGISTRATION_MODE_RESTRICTED
  configSchema.statics.SECURITY_REGISTRATION_MODE_CLOSED = SECURITY_REGISTRATION_MODE_CLOSED

  return mongoose.model('Config', configSchema)
}
