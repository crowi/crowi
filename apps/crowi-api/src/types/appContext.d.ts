export type AppContext = {
  title: string
  path: string
  url: string
  auth: {
    requireThirdPartyAuth: boolean
    disablePasswordAuth: boolean
    canDisconnectThirdPartyId: boolean
    providers: {
      google: boolean
      github: boolean
    }
  }
  upload: {
    image: boolean
    file: boolean
  }
  search: {
    isConfigured: boolean
  }
  security: {
    registrationWhiteList: string[]
  }
  user: {
    _id: string | null
    name: string
    username: string
    image: string
    email: string | null
    googleId: string | null
    githubId: string | null
    admin: boolean
    language: string
  }
  env: {
    PLANTUML_URI: string | null
    MATHJAX: string | null
  }
  config: {
    crowi: {
      'app:confidential': string | null
    }
  }
  csrfToken: string
}
