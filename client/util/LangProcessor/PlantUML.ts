import CrowiUtil from 'client/crowi'
import plantuml from 'plantuml-encoder'
import * as crypto from 'crypto'
import crowi from 'client/util/Crowi'

export default class PlantUML {
  crowi: crowi

  constructor(crowi: crowi) {
    this.crowi = crowi
  }

  generateId(token: string) {
    const hasher = crypto.createHash('md5')
    hasher.update(token)
    return hasher.digest('hex')
  }

  process(code: string, lang: string) {
    const { env } = this.crowi.getContext()

    if (!env.PLANTUML_URI) {
      return `<pre class="wiki-code"><code>${CrowiUtil.escape(code)}\n</code></pre>`
    }

    let plantumlUri = env.PLANTUML_URI
    if (plantumlUri.substr(-1) !== '/') {
      plantumlUri += '/'
    }
    const id = this.generateId(code + lang)
    const encoded = plantuml.encode(`@startuml

skinparam monochrome true

${code}
@enduml`)

    return `
      <div id="${id}" class="plantuml noborder">
        <img src="${plantumlUri}svg/${encoded}">
      </div>
    `
  }
}
