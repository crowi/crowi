import React from 'react';
import PropTypes from 'prop-types';

import Button from 'react-bootstrap/es/Button';
import Modal from 'react-bootstrap/es/Modal';

import dateFnsFormat from 'date-fns/format';

import ReactUtils from '../ReactUtils';
import UserPicture from '../User/UserPicture';

export default class DeleteCommentModal extends React.Component {

  /*
   * the threshold for omitting body
   */
  static get OMIT_BODY_THRES() { return 400 };

  constructor(props) {
    super(props);
  }

  componentWillMount() {
  }

  render() {
    if (this.props.comment === undefined) {
      return <div></div>
    }

    const comment = this.props.comment;
    const commentDate = dateFnsFormat(comment.createdAt, 'YYYY/MM/DD HH:mm');

    // generate body
    let commentBody = comment.comment;
    if (commentBody.length > DeleteCommentModal.OMIT_BODY_THRES) { // omit
      commentBody = commentBody.substr(0, DeleteCommentModal.OMIT_BODY_THRES) + '...';
    }
    commentBody = ReactUtils.nl2br(commentBody);

    return (
      <Modal show={this.props.isShown} onHide={this.props.cancel} className="page-comment-delete-modal">
        <Modal.Header closeButton>
          <Modal.Title>Delete comment?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <UserPicture user={comment.creator} size="xs" /> <strong>{comment.creator.username}</strong> wrote on {commentDate}:
          <p className="comment-body">{commentBody}</p>
        </Modal.Body>
        <Modal.Footer>
          <span className="text-danger">{this.props.errorMessage}</span>&nbsp;
          <Button onClick={this.props.cancel}>Cancel</Button>
          <Button onClick={this.props.confirmedToDelete} className="btn-danger">Delete</Button>
        </Modal.Footer>
      </Modal>
    );
  }

}

DeleteCommentModal.propTypes = {
  isShown: PropTypes.bool.isRequired,
  comment: PropTypes.object,
  errorMessage: PropTypes.string,
  cancel: PropTypes.func.isRequired,            // for cancel evnet handling
  confirmedToDelete: PropTypes.func.isRequired, // for confirmed event handling
};
