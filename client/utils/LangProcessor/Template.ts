import Crowi from 'client/crowi'
import { format } from 'date-fns'
import { pencilOutline } from 'components/Common/Icons'
import renderIcon from 'common/functions/renderIcon'

type templatePatternKey = keyof Template['templatePattern']

export default class Template {
  templatePattern: {
    year: () => string
    month: () => string
    date: () => string
    user: () => string
  }

  constructor(crowi: Crowi) {
    this.templatePattern = {
      year: this.getYear,
      month: this.getMonth,
      date: this.getDate,
      user: this.getUser,
    }
  }

  getYear(): string {
    return format(new Date(), 'yyyy')
  }

  getMonth(): string {
    return format(new Date(), 'yyyy/MM')
  }

  getDate(): string {
    return format(new Date(), 'yyyy/MM/dd')
  }

  getUser() {
    // FIXME
    const { username } = window.crowi.getUser()

    return username ? `/user/${username}` : ''
  }

  parseTemplateString(templateString: string) {
    let parsed = templateString

    const templatePatternKeys = Object.keys(this.templatePattern) as templatePatternKey[]
    templatePatternKeys.forEach((key) => {
      const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matcher = new RegExp(`{${k}}`, 'g')
      if (parsed.match(matcher)) {
        const replacer = this.templatePattern[key]()
        parsed = parsed.replace(matcher, replacer)
      }
    })

    return parsed
  }

  process(code: string, lang: string) {
    const templateId = new Date().getTime().toString(16) + Math.floor(1000 * Math.random()).toString(16)
    let pageName = lang
    if (lang.match(':')) {
      pageName = this.parseTemplateString(lang.split(':')[1])
    }
    code = this.parseTemplateString(code)
    return `
    <div class="page-template-builder">
    <button class="template-create-button btn btn-secondary" data-template="${templateId}" data-path="${pageName}">${renderIcon(
      pencilOutline,
    )} ${pageName}</button>
      <pre><code id="${templateId}" class="lang-${lang}">${code}\n</code></pre></div>\n`
  }
}
