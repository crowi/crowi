import Crowi from '../Crowi'

export default class Tsv2Table {
  option: {
    header?: boolean
  }

  constructor(crowi: Crowi, option = {}) {
    if (!option) {
      option = {}
    }
    this.option = option
    this.option.header = this.option.header || false
  }

  splitColums(line: string) {
    // \t is replaced to '    ' by Lexer.lex(), so split by 4 spaces
    return line.split(/\s{4}/g)
  }

  getTableHeader(codeLines: string[]) {
    let headers: string[] = []
    const headLine = codeLines[0] || ''

    // console.log('head', headLine);
    headers = this.splitColums(headLine).map((col) => {
      return `<th>${Crowi.escape(col)}</th>`
    })

    return `<tr>
      ${headers.join('\n')}
    </tr>`
  }

  getTableBody(codeLines: string[]) {
    if (this.option.header) {
      codeLines.shift()
    }

    const rows = codeLines.map((row) => {
      const cols = this.splitColums(row)
        .map((col) => {
          return `<td>${Crowi.escape(col)}</td>`
        })
        .join('')
      return `<tr>${cols}</tr>`
    })

    return rows.join('\n')
  }

  process(code: string) {
    const codeLines: string[] = code.split(/\n|\r/)

    let header = ''
    if (this.option.header) {
      header = `<thead>
        ${this.getTableHeader(codeLines)}
      </thead>`
    }

    return `<table>
      ${header}
      <tbody>
        ${this.getTableBody(codeLines)}
      </tbody>
    </table>`
  }
}
