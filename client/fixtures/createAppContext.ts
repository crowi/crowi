import { AppContext } from 'server/types/appContext'

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U> ? Array<DeepPartial<U>> : T[P] extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : DeepPartial<T[P]>
}

export const createAppContext = (appContext: DeepPartial<AppContext> = {}) =>
  (window.APP_CONTEXT = {
    title: '',
    path: '',
    url: '',
    auth: {
      requireThirdPartyAuth: false,
      disablePasswordAuth: false,
      ...appContext.auth,
    },
    upload: {
      image: false,
      file: false,
      ...appContext.upload,
    },
    search: {
      isConfigured: false,
      ...appContext.search,
    },
    user: {
      _id: null,
      name: '',
      username: '',
      image: '',
      email: null,
      googleId: null,
      githubId: null,
      admin: false,
      language: '',
      ...appContext.user,
    },
    env: {
      PLANTUML_URI: null,
      MATHJAX: null,
      ...appContext.env,
    },
    config: {
      crowi: {
        'app:confidential': null,
      },
      ...appContext.config,
    },
    csrfToken: '',
    ...appContext,
  } as AppContext)
