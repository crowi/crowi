import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button, Modal } from 'react-bootstrap'

class DeleteConfirmModal extends React.Component {
  render() {
    const { show, onHide, handleDelete, t } = this.props
    return (
      <Modal show={show} onHide={onHide}>
        <Modal.Header closeButton>
          <Modal.Title>{t('Delete shared link to this page?')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>{t('No one can see this page if the link is deleted')}</Modal.Body>
        <Modal.Footer>
          <Button onClick={onHide}>{t('Cancel')}</Button>
          <Button onClick={handleDelete} bsStyle="danger">
            {t('Delete')}
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
  t: PropTypes.func.isRequired,
}
DeleteConfirmModal.defaultProps = {
  show: false,
}

export default translate()(DeleteConfirmModal)
