import Crowi from 'client/crowi'
import crowi from 'client/utils/Crowi'
import crowiAuth from 'client/utils/CrowiAuth'
import crowiRenderer from 'client/utils/CrowiRenderer'
import JQuery from 'jquery'

declare global {
  interface Window {
    Crowi: Crowi
    crowi: crowi
    crowiAuth: crowiAuth
    crowiRenderer: crowiRenderer
    Reveal: {}
    MathJax: {}
    inlineAttachment: any
  }

  interface Error {
    info?: any
  }

  interface JQuery {
    selection: (mode?: string, opts?: {}) => any
  }

  interface Navigator {
    userLanguage?: string
  }
}
