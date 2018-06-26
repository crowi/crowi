import React from 'react'
import PropTypes from 'prop-types'

import UserPicture from './User/UserPicture'

class Backlink extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      currentOffset: 0,
      hasNext: false,
      backLinks: [],
    }
  }

  componentDidMount() {
    this.fetchBacklinks()
  }

  fetchBacklinks() {
    this.props.crowi
      .apiGet('/backlink.list', {
        page_id: this.props.pageId,
        limit: this.props.limit + 1,
        offset: this.state.currentOffset,
      })
      .then(response => {
        if (response.ok !== true) {
          console.log('Sorry, something went wrong.')
        } else {
          let hasNext = false
          if (response.data.length > this.props.limit) {
            hasNext = true
          }
          const appendBacklinks = response.data.slice(0, this.props.limit)

          let backLinks = this.state.backLinks
          let i = 0
          appendBacklinks.forEach(backLink => {
            const index = this.state.currentOffset + i
            backLinks[index] = backLink
            i++
          })

          const currentOffset = this.state.currentOffset + this.props.limit

          this.setState({
            currentOffset: currentOffset,
            hasNext: hasNext,
            backLinks: backLinks,
          })
        }
      })
      .catch(err => {
        console.log('Failed to fetch data of Backlinks')
        // console.log(err);
      })
  }

  handleReadMore(e) {
    e.preventDefault()
    this.fetchBacklinks()
  }

  createList(backlink) {
    const path = backlink.fromPage.path
    const user = backlink.fromRevision.author

    return (
      <li className="backlink-item" key={'crowi:page:backlink:' + backlink._id}>
        <a className="backlink-link" href={path}>
          <span className="backlink-picture">
            <UserPicture user={user} />
          </span>
          <span className="backlink-path">{path}</span>
        </a>
      </li>
    )
  }

  createReadMore() {
    if (this.state.hasNext === true) {
      return (
        <p className="backlink-readmore">
          <a href="#" onClick={e => this.handleReadMore(e)}>
            Read More Backlinks
          </a>
        </p>
      )
    }
    return <p />
  }

  render() {
    const lists = this.state.backLinks.map(backLink => this.createList(backLink))

    if (lists.length === 0) {
      return <div className="backlink" />
    }

    const readMore = this.createReadMore()

    return (
      <div>
        <p className="backlink-title">Backlinks</p>
        <ul className="backlink-list">{lists}</ul>
        {readMore}
      </div>
    )
  }
}

Backlink.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  limit: PropTypes.number,
  offset: PropTypes.number,
}

Backlink.defaultProps = {
  pageId: null,
  limit: 5,
  offset: 0,
}

export default Backlink
