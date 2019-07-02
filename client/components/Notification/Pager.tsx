import React from 'react'

interface Props {
  hasPrev: boolean
  hasNext: boolean
  handlePrevClick: Function
  handleNextClick: Function
}

export default class Pager extends React.Component<Props> {
  static defaultProps = {
    hasPrev: false,
    hasNext: false,
  }

  handleOnPrevClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    this.props.handlePrevClick()
  }

  handleOnNextClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    this.props.handleNextClick()
  }

  renderPrev() {
    if (this.props.hasPrev) {
      return <a onClick={this.handleOnPrevClick.bind(this)}>Prev</a>
    }

    return null
  }

  renderNext() {
    if (this.props.hasNext) {
      return <a onClick={this.handleOnNextClick.bind(this)}>Next</a>
    }

    return null
  }

  render() {
    const next = this.renderNext()
    const prev = this.renderPrev()

    return (
      <div className="notification-pager">
        <div className="pager pager-prev">{prev}</div>
        <div className="pager pager-next">{next}</div>
      </div>
    )
  }
}
