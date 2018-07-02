import React from 'react'
import PropTypes from 'prop-types'

// Pagination component of react-bootstrap did not work...
export default class Pagination extends React.Component {
  onClick(i) {
    const { onClick } = this.props
    return e => {
      e.preventDefault()
      if (onClick) {
        onClick(i)
      }
    }
  }

  render() {
    const { current, count } = this.props
    if (current < 1 || count < 1) {
      return null
    }
    const range = [...Array(count).keys()]
    const items = range.map((v, k) => {
      const page = k + 1
      const className = page === current ? 'active' : ''
      return (
        <li key={page} className={className}>
          <a onClick={this.onClick(page)}>{page}</a>
        </li>
      )
    })
    return (
      <nav>
        <ul className="pagination">
          <li className={current === 1 ? 'disabled' : ''}>
            <a onClick={this.onClick(1)}>&laquo;</a>
          </li>
          {items}
          <li className={current === count ? 'disabled' : ''}>
            <a onClick={this.onClick(count)}>&raquo;</a>
          </li>
        </ul>
      </nav>
    )
  }
}

Pagination.propTypes = {
  current: PropTypes.number.isRequired,
  count: PropTypes.number.isRequired,
  onClick: PropTypes.func.isRequired,
}
