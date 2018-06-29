import React from 'react'
import PropTypes from 'prop-types'
import { Button, Modal } from 'react-bootstrap'

export default class DeleteConfirmModal extends React.Component {
  render() {
    const { show, onHide, handleDelete } = this.props
    return (
      <Modal show={show} onHide={onHide}>
        <Modal.Header closeButton>
          <Modal.Title>このページへの共有リンクを削除しますか？</Modal.Title>
        </Modal.Header>
        <Modal.Body>リンクが削除されると、そのリンクからこのページを見ることはできなくなります。</Modal.Body>
        <Modal.Footer>
          <Button onClick={onHide}>キャンセル</Button>
          <Button onClick={handleDelete} bsStyle="danger">
            削除
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }
}

DeleteConfirmModal.propTypes = {
  show: PropTypes.bool.isRequired,
  onHide: PropTypes.func.isRequired,
  handleDelete: PropTypes.func.isRequired,
}
DeleteConfirmModal.defaultProps = {
  show: false,
}
