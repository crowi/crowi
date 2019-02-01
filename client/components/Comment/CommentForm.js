import React from 'react'
import PropTypes from 'prop-types'

import Emitter from '../../emitter'

class CommentForm extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      comment: '',
      message: '',
      posting: false,
    }

    this.onChange = this.onChange.bind(this)
    this.postComment = this.postComment.bind(this)
  }

  onChange(e) {
    this.setState({ comment: e.target.value })
  }

  async postComment() {
    const { crowi, pageId, revisionId } = this.props
    const { comment } = this.state
    try {
      this.setState({ posting: true })
      const { ok, error } = await crowi.apiPost('/comments.add', {
        commentForm: {
          comment,
          page_id: pageId,
          revision_id: revisionId,
        },
      })
      if (ok) {
        this.setState({ comment: '', message: '' })
        Emitter.emit('comment:update')
      } else {
        this.setState({ message: error })
      }
    } catch (err) {
      this.setState({ message: err.message })
    } finally {
      this.setState({ posting: false })
    }
  }

  render() {
    const { comment, message, posting } = this.state
    return (
      <div className="form page-comment-form" id="page-comment-form">
        <div className="comment-form">
          <div className="comment-form-main">
            <textarea className="comment-form-comment form-control" value={comment} onChange={this.onChange} />
            <div className="comment-submit">
              <span className="text-danger">{message}</span>
              <button className="btn btn-primary btn-sm form-inline" onClick={this.postComment} disabled={posting}>
                Comment
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

CommentForm.propTypes = {
  crowi: PropTypes.object.isRequired,
  pageId: PropTypes.string.isRequired,
  revisionId: PropTypes.string.isRequired,
}

export default CommentForm
