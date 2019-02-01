import React from 'react'
import PropTypes from 'prop-types'

import CommentList from './CommentList'
import Emitter from '../../emitter'

class CommentLists extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      current: [],
      newer: [],
      older: [],
    }

    this.fetchComments = this.fetchComments.bind(this)

    Emitter.on('comment:update', this.fetchComments)
  }

  componentDidMount() {
    this.fetchComments()
  }

  async fetchComments() {
    const { crowi, pageId, revisionId, revisionCreatedAt } = this.props
    const { ok, comments } = await crowi.apiGet('/comments.get', { page_id: pageId })
    const [current, newer, older] = [[], [], []]
    if (ok) {
      comments.forEach(comment => {
        const { revision, createdAt } = comment
        const isCurrent = revision === revisionId
        const isNewer = Date.parse(createdAt) / 1000 > revisionCreatedAt

        const target = isCurrent ? current : isNewer ? newer : older
        target.push(comment)
      })
      this.setState({ current, newer, older })
    }
  }

  renderNewer() {
    const { newer } = this.state
    const { crowi, revisionId } = this.props
    if (newer.length)
      return (
        <>
          <CommentList className="page-comments-list-newer collapse" id="page-comments-list-newer" crowi={crowi} comments={newer} revisionId={revisionId} />
          <a className="page-comments-list-toggle-newer text-center" data-toggle="collapse" href="#page-comments-list-newer">
            <i className="fa fa-angle-double-up" /> Comments for Newer Revision <i className="fa fa-angle-double-up" />
          </a>
        </>
      )
  }

  renderOlder() {
    const { older } = this.state
    const { crowi, revisionId } = this.props
    if (older.length)
      return (
        <>
          <a className="page-comments-list-toggle-older text-center" data-toggle="collapse" href="#page-comments-list-older">
            <i className="fa fa-angle-double-down" /> Comments for Older Revision <i className="fa fa-angle-double-down" />
          </a>
          <CommentList className="page-comments-list-older collapse in" id="page-comments-list-older" crowi={crowi} comments={older} revisionId={revisionId} />
        </>
      )
  }

  render() {
    const { isSharePage, crowi, revisionId } = this.props
    const { current } = this.state
    return (
      !isSharePage && (
        <div className="page-comments-list" id="page-comments-list">
          {this.renderNewer()}
          <CommentList className="page-comments-list-current" id="page-comments-list-current" crowi={crowi} comments={current} revisionId={revisionId} />
          {this.renderOlder()}
        </div>
      )
    )
  }
}

CommentLists.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  revisionId: PropTypes.string.isRequired,
  revisionCreatedAt: PropTypes.string.isRequired,
  isSharePage: PropTypes.bool.isRequired,
}

export default CommentLists
