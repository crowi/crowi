import showdown from 'showdown';
import hljs from 'highlight.js';

import MarkdownFixer from './PreProcessor/MarkdownFixer';
import Linker        from './PreProcessor/Linker';
import ImageExpander from './PreProcessor/ImageExpander';

import Emoji         from './PostProcessor/Emoji';
import Mathjax       from './PostProcessor/Mathjax';

import Tsv2Table from './LangProcessor/Tsv2Table';
import Template from './LangProcessor/Template';
import PlantUML from './LangProcessor/PlantUML';

export default class CrowiRenderer {


  constructor(crowi) {
    this.crowi = crowi;

    this.preProcessors = [
      new MarkdownFixer(crowi),
      new Linker(crowi),
      new ImageExpander(crowi),
    ];
    this.postProcessors = [
      new Emoji(crowi),
      new Mathjax(crowi),
    ];

    this.langProcessors = {
      'tsv': new Tsv2Table(crowi),
      'tsv-h': new Tsv2Table(crowi, {header: true}),
      'template': new Template(crowi),
      'plantuml': new PlantUML(crowi),
    };

    this.parseMarkdown = this.parseMarkdown.bind(this);
    this.codeRenderer = this.codeRenderer.bind(this);
  }

  preProcess(markdown, dom) {
    for (let i = 0; i < this.preProcessors.length; i++) {
      if (!this.preProcessors[i].process) {
        continue;
      }
      markdown = this.preProcessors[i].process(markdown, dom);
    }
    return markdown;
  }

  postProcess(html, dom) {
    for (let i = 0; i < this.postProcessors.length; i++) {
      if (!this.postProcessors[i].process) {
        continue;
      }
      html = this.postProcessors[i].process(html, dom);
    }

    return html;
  }

  codeRenderer(code, lang, escaped) {
    let result = '', hl;

    if (lang) {
      const langAndFn = lang.split(':');
      const langPattern = langAndFn[0];
      const langFn = langAndFn[1] || null;
      if (this.langProcessors[langPattern]) {
        return this.langProcessors[langPattern].process(code, lang);
      }

      try {
        hl = hljs.highlight(langPattern, code);
        result = hl.value;
        escaped = true;
      } catch (e) {
        result = code;
      }

      result = (escape ? result : Crowi.escape(result, true));

      let citeTag = '';
      if (langFn) {
        citeTag = `<cite>${langFn}</cite>`;
      }
      return `<pre class="wiki-code wiki-lang">${citeTag}<code class="lang-${lang}">${result}\n</code></pre>\n`;
    }

    // no lang specified
    return `<pre class="wiki-code"><code>${Crowi.escape(code, true)}\n</code></pre>`;

  }

  parseMarkdown(markdown, dom) {
    let parsed = '';

    // https://github.com/showdownjs/showdown#valid-options
    const converter = new showdown.Converter();
    showdown.setFlavor('github');

    try {
      parsed = converter.makeHtml(markdown);
    } catch (e) { console.log(e, e.stack); }

    return parsed;
  }

  render(markdown, dom) {
    let html = '';

    markdown = this.preProcess(markdown, dom);
    html = this.parseMarkdown(markdown, dom);
    html = this.postProcess(html, dom);

    return html;
  }
}
