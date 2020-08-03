declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV: 'development' | 'production' | 'test'
    readonly PORT: string
    readonly BASE_URL: string
    readonly SECRET_TOKEN: string
    readonly PASSWORD_SEED: string
    readonly FILE_UPLOAD: string | undefined
    readonly ENABLE_DNSCACHE: string | undefined
    readonly MATHJAX: string | undefined
    readonly PLANTUML_URI: string | undefined
    readonly REDISTOGO_URL: string | undefined
    readonly REDIS_URL: string | undefined
    readonly ELASTICSEARCH_URI: string | undefined
    readonly BONSAI_URL: string | undefined
    readonly MONGOLAB_URI: string | undefined
    readonly MONGODB_URI: string | undefined
    readonly MONGOHQ_URL: string | undefined
    readonly MONGO_URI: string | undefined
  }
}
