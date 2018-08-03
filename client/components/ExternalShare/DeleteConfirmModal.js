import React from 'react'
import PropTypes from 'prop-types'
import { translate } from 'react-i18next'
import { Button, Modal, Alert } from 'react-bootstrap'

class DeleteConfirmModal extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      error: false,
    }

    this.handleDelete = this.handleDelete.bind(this)
  }

  async handleDelete() {
    const { handleClose, handleDelete } = this.props
    this.setState({ error: false })
    const error = await handleDelete()
    if (error !== null) {
      this.setState({ error: true })
    } else {
      handleClose()
    }
  }

  render() {
    const { show, onHide, t } = this.props
    const { error } = this.state
    return (
      <Modal show={show} onHide={onHide}>
        <Modal.Header closeButton>
          <Modal.Title>{t('Delete shared link to this page?')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert bsStyle="danger">{t('share.error.can_not_delete')}</Alert>}
          <p>{t('No one can see this page if the link is deleted')}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={onHide}>{t('Cancel')}</Button>
          <Button onClick={this.handleDelete} bsStyle="danger">
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
  handleClose: PropTypes.func.isRequired,
  t: PropTypes.func.isRequired,
}
DeleteConfirmModal.defaultProps = {
  show: false,
}

export default translate()(DeleteConfirmModal)
