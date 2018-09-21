// @flow
import React from 'react'

type Props = {
  page: Object,
  highlightKeywords?: string,
  pageBody?: string,
}

export default class PageBody extends React.Component<Props> {
  static defaultProps = {
    page: {},
    pageBody: '',
  }

  crowiRenderer: Function

  constructor(props: Props) {
    super(props)

    this.crowiRenderer = window.crowiRenderer // FIXME
  }

  getHighlightBody = (body: string, keywords: string) => {
    let returnBody = body

    keywords
      .replace(/"/g, '')
      .split(' ')
      .forEach(keyword => {
        if (keyword === '') {
          return
        }
        const k = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(^"|"$)/g, '') // for phrase (quoted) keyword
        const keywordExp = new RegExp(`(${k}(?!(.*?")))`, 'ig')
        returnBody = returnBody.replace(keywordExp, '<em class="highlighted">$&</em>')
      })

    return returnBody
  }

  getMarkupHTML = () => {
    let body = this.props.pageBody
    if (body === '') {
      body = this.props.page.revision.body
    }

    body = this.crowiRenderer.render(body)

    if (this.props.highlightKeywords) {
      body = this.getHighlightBody(body, this.props.highlightKeywords)
    }

    return { __html: body }
  }

  render() {
    let parsedBody = this.getMarkupHTML()

    return <div className="content" dangerouslySetInnerHTML={parsedBody} />
  }
}
