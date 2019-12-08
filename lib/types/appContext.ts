import i18next from 'i18next'

export type AppContext = {
  title: string
  path: string
  upload: {
    image: boolean
    file: boolean
  }
  search: {
    isConfigured: boolean
  }
  user: {
    _id: string
    name: string
    username: string
    image: string
    email?: string
    googleId?: string
    githubId?: string
    admin?: boolean
  } | null
  env: {
    PLANTUML_URI: string | null
    MATHJAX: string | null
  }
  config: {
    crowi: any
  }
  csrfToken: string
  hydrated: {
    local: string
    user: string
    ssr: string
  }
  i18n: i18next.i18n
}
