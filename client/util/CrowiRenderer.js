import Crowi from './Crowi'

import marked from 'marked'
import hljs from 'highlight.js'

import SectionFixer from './PreProcessor/SectionFixer'
import PageLinker from './PreProcessor/PageLinker'
import ImageExpander from './PreProcessor/ImageExpander'

import Emoji from './PostProcessor/Emoji'
import Mathjax from './PostProcessor/Mathjax'

import Tsv2Table from './LangProcessor/Tsv2Table'
import Template from './LangProcessor/Template'
import PlantUML from './LangProcessor/PlantUML'

export default class CrowiRenderer {
  constructor(crowi) {
    this.crowi = crowi

    this.preProcessors = [new SectionFixer(crowi), new PageLinker(crowi), new ImageExpander(crowi)]
    this.postProcessors = [new Emoji(crowi), new Mathjax(crowi)]

    this.langProcessors = {
      tsv: new Tsv2Table(crowi),
      'tsv-h': new Tsv2Table(crowi, { header: true }),
      template: new Template(crowi),
      plantuml: new PlantUML(crowi),
    }

    this.codeRenderer = this.codeRenderer.bind(this)

    this.renderer = new marked.Renderer()
    this.renderer.code = this.codeRenderer

    marked.setOptions({
      gfm: true,
      tables: true,
      breaks: true,
      pedantic: false,
      sanitize: false,
      smartLists: true,
      smartypants: false,
      renderer: this.renderer,
    })
  }

  preProcess(tokens, dom) {
    for (let processor of this.preProcessors) {
      if (processor.process) {
        tokens = processor.process(tokens, dom)
      }
    }
    return tokens
  }

  postProcess(html, dom) {
    for (let processor of this.postProcessors) {
      if (!processor.process) {
        html = processor.process(html, dom)
      }
    }

    return html
  }

  codeRenderer(code, lang, escaped) {
    let result = ''
    let hl

    if (lang) {
      const langAndFn = lang.split(':')
      const langPattern = langAndFn[0]
      const langFn = langAndFn[1] || null
      if (this.langProcessors[langPattern]) {
        return this.langProcessors[langPattern].process(code, lang)
      }

      try {
        hl = hljs.highlight(langPattern, code)
        result = hl.value
        escaped = true
      } catch (e) {
        result = code
      }

      result = escape ? result : Crowi.escape(result, true)

      let citeTag = ''
      if (langFn) {
        citeTag = `<cite>${langFn}</cite>`
      }
      return `<pre class="wiki-code wiki-lang">${citeTag}<code class="lang-${lang}">${result}\n</code></pre>\n`
    }

    // no lang specified
    return `<pre class="wiki-code"><code>${Crowi.escape(code, true)}\n</code></pre>`
  }

  lex(markdown, dom) {
    // override
    marked.Lexer.lex = function(src, options) {
      const lexer = new marked.Lexer(options)

      // this is maybe not an official way
      if (lexer.rules) {
        lexer.rules.fences = /^ *(`{3,}|~{3,})[ .]*([^\r\n]+)? *\n([\s\S]*?)\s*\1 *(?:\n+|$)/
      }

      return lexer.lex(src)
    }

    try {
      return marked.lexer(markdown)
    } catch (e) {
      console.log(e, e.stack)
    }
  }

  parse(tokens, dom) {
    try {
      return marked.parser(tokens)
    } catch (e) {
      console.log(e, e.stack)
    }
  }

  render(markdown, dom) {
    let tokens = []
    let html = ''

    tokens = this.lex(markdown)
    tokens = this.preProcess(tokens, dom)
    html = this.parse(tokens, dom)
    html = this.postProcess(html, dom)

    return html
  }
}
