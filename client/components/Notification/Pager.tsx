import React from 'react'
import PropTypes from 'prop-types'

export default class Pager extends React.Component {
  handleOnPrevClick(e) {
    e.preventDefault()
    this.props.handlePrevClick()
  }

  handleOnNextClick(e) {
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

Pager.propTypes = {
  hasPrev: PropTypes.bool.isRequired,
  hasNext: PropTypes.bool.isRequired,
  handlePrevClick: PropTypes.func.isRequired,
  handleNextClick: PropTypes.func.isRequired,
}
Pager.defaultProps = {
  hasPrev: false,
  hasNext: false,
}
