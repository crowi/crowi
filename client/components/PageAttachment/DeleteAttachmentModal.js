// @flow
import React from 'react'
import { Button, Modal, ModalHeader, ModalBody, ModalFooter } from 'reactstrap'

import Icon from 'components/Common/Icon'
import User from 'components/User/User'

type Props = {
  inUse: ?boolean,
  deleting?: boolean,
  deleteError?: string,
  attachmentToDelete: ?Object,
  onAttachmentDeleteClickedConfirm?: Function,
}

export default class DeleteAttachmentModal extends React.Component<Props> {
  _onDeleteConfirm = () => {
    if (this.props.onAttachmentDeleteClickedConfirm) {
      this.props.onAttachmentDeleteClickedConfirm(this.props.attachmentToDelete)
    }
  }

  renderByFileFormat(attachment: Object) {
    if (attachment.fileFormat.match(/image\/.+/i)) {
      return (
        <p className="attachment-delete-image">
          <span>
            {attachment.originalName} uploaded by <User user={attachment.creator} username />
          </span>
          <img src={attachment.url} />
        </p>
      )
    }

    return (
      <p className="attachment-delete-file">
        <Icon name="file-o" />
        <span>
          {attachment.originalName} uploaded by <User user={attachment.creator} username />
        </span>
      </p>
    )
  }

  render() {
    const attachment = this.props.attachmentToDelete
    if (attachment === undefined || attachment === null) {
      return null
    }

    const props = Object.assign({}, this.props)
    delete props.onAttachmentDeleteClickedConfirm
    delete props.attachmentToDelete
    delete props.inUse
    delete props.deleting
    delete props.deleteError

    let deletingIndicator = ''
    if (this.props.deleting) {
      deletingIndicator = <Icon name="spinner" spin />
    }
    if (this.props.deleteError) {
      deletingIndicator = <p>{this.props.deleteError}</p>
    }

    let renderAttachment = this.renderByFileFormat(attachment)

    return (
      <Modal {...props} className="attachment-delete-modal modal-large">
        <ModalHeader>Delete attachment?</ModalHeader>
        <ModalBody>{renderAttachment}</ModalBody>
        <ModalFooter>
          {deletingIndicator}
          <Button onClick={this._onDeleteConfirm} color="danger" disabled={this.props.deleting}>
            Delete!
          </Button>
        </ModalFooter>
      </Modal>
    )
  }
}
