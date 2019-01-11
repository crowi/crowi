import React from 'react'
import PropTypes from 'prop-types'

class SearchToolbarSentinel extends React.Component {
  constructor(props) {
    super(props)

    this.setSentinel = this.setSentinel.bind(this)
  }

  setSentinel(element) {
    const { onStickyChange } = this.props
    const observer = new IntersectionObserver(([entry]) => {
      onStickyChange(!entry.isIntersecting)
    })
    observer.observe(element)
  }

  render() {
    return <div className="search-toolbar-sticky-sentinel" ref={this.setSentinel} />
  }
}

SearchToolbarSentinel.propTypes = {
  onStickyChange: PropTypes.func.isRequired,
}

export default SearchToolbarSentinel
