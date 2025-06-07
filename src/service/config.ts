import Debug from 'debug'
import { v4 } from 'uuid'
import { createClient } from 'redis'
import Crowi from 'src/crowi'
import ConfigEvent from 'src/events/config'

const debug = Debug('crowi:service:config')

export default class ConfigService {
  crowi: Crowi

  config: any

  configModel: any

  event: ConfigEvent

  pubSub: {
    id: string
    publisher: any
    subscriber: any
    channel: string
  }

  constructor(crowi: Crowi) {
    this.crowi = crowi
    // this config is a local memory cache
    this.config = {}
    this.configModel = this.crowi.model('Config')
    this.event = this.crowi.event('Config')

    this.pubSub = {
      id: v4(),
      publisher: null,
      subscriber: null,
      channel: 'config',
    }

    // setupPubSub will be called from Crowi.setupConfig()

    this.event.on('config:updated', this.postUpdate.bind(this))
  }

  async load() {
    const Config = this.crowi.model('Config')
    const config = await Config.loadAllConfig()
    this.set(config)
  }

  set(config) {
    // FIXME: Deep copy to avoid deleting itself.
    const newConfig = { ...config }
    // FIXME: Treat as a mutable object always.
    //        We should always get config using `crowi.getConfig()` *just before* referencing config.
    for (const key of Object.keys(this.config)) {
      delete this.config[key]
    }
    for (const key of Object.keys(newConfig)) {
      this.config[key] = newConfig[key]
    }
  }

  get(ns?: string, key?: string) {
    if (ns && key) {
      if (!this.config[ns]) {
        throw new Error(`No such namespace in config: ${ns}`)
      }

      return this.config[ns][key]
    }

    return this.config || {}
  }

  async notifyUpdated() {
    // To notify config updated to another srever, publish event via pubsub.
    const { publisher, channel, id } = this.pubSub
    if (publisher) {
      try {
        await publisher.publish(channel, JSON.stringify({ id }))
      } catch (error) {
        debug('Failed to publish config update:', (error as Error).message)
      }
    }

    // To notify config updated to the server itself, emit the event
    this.event.emit('config:updated')
  }

  async postUpdate() {
    debug('Config updated run postUpdate')
    await Promise.all([this.crowi.setupSlack(), this.crowi.setupMailer()])
  }

  async saveConfig(ns: string, config: Record<string, any>) {
    debug('Save config', ns, config)
    await this.configModel.updateConfigByNamespace(ns, config)

    this.update({ ...this.config, [ns]: { ...this.config[ns], ...config } })
  }

  async saveConfigValue(ns: string, key: string, value: any) {
    debug('Save config value', ns, key, value)
    await this.configModel.updateConfig(ns, key, value)
    this.update({ ...this.config, [ns]: { ...this.config[ns], [key]: value } })
  }

  async deleteConfig(ns: string, key: string) {
    await this.configModel.deleteConfig(ns, key)
    delete this.config[ns][key]
    this.update(this.config)
  }

  /**
   * To update the property of ConfigService,
   * the config serice user (e.g. some controller, model, etc.) must call this update() method.
   * Otherwise,
   *  - the config memory cache would not be refreshed,
   *  - the service like Slack, Mailer etc. would not be reloaded,
   *  - the other server (in multi-server structure) would not be notified the config updated.
   */
  update(config) {
    this.set(config)
    this.notifyUpdated()
  }

  async setupPubSub() {
    const { redisOpts } = this.crowi

    if (redisOpts) {
      try {
        this.pubSub.publisher = createClient(redisOpts)
        this.pubSub.subscriber = createClient(redisOpts)
        
        await this.pubSub.publisher.connect()
        await this.pubSub.subscriber.connect()

        const { pubSub } = this
        const { subscriber } = pubSub

        debug('PubSubId', pubSub.id)

        if (subscriber) {
          subscriber.on('message', async (channel, message) => {
            if (channel !== pubSub.channel) return

            const { id } = JSON.parse(message)
            if (id === pubSub.id) return

            await this.load()
            this.event.emit('config:updated')

            debug(`Config updated by ${id}`)
          })

          await subscriber.subscribe(pubSub.channel)
        }
        
        debug('Redis pub/sub setup completed')
      } catch (error) {
        debug('Failed to setup Redis pub/sub:', (error as Error).message)
        console.warn('Redis pub/sub setup failed. Config synchronization disabled.')
        this.pubSub.publisher = null
        this.pubSub.subscriber = null
      }
    }
  }
}
