import React from 'react'
import { Button, Modal, ModalHeader, ModalBody, ModalFooter } from 'reactstrap'

import Icon from 'components/Common/Icon'
import User from 'components/User/User'

import { Attachment } from 'client/types/crowi'

interface Props {
  inUse: boolean
  isOpen: boolean
  toggle: () => void
  deleting: boolean
  deleteError: string
  attachmentToDelete: Attachment | null
  onAttachmentDeleteClickedConfirm: Function
}

export default class DeleteAttachmentModal extends React.Component<Props> {
  constructor(props: Props) {
    super(props)

    this._onDeleteConfirm = this._onDeleteConfirm.bind(this)
  }

  _onDeleteConfirm() {
    this.props.onAttachmentDeleteClickedConfirm(this.props.attachmentToDelete)
  }

  renderByFileFormat(attachment: Attachment) {
    if (attachment.fileFormat.match(/image\/.+/i)) {
      return (
        <p className="attachment-delete-image">
          <span>
            {attachment.originalName} uploaded by <User user={attachment.creator} username />
          </span>
          <br />
          <img src={attachment.url} />
        </p>
      )
    }

    return (
      <p className="attachment-delete-file">
        <Icon name="fileOutline" />
        <span>
          {attachment.originalName} uploaded by <User user={attachment.creator} username />
        </span>
      </p>
    )
  }

  render() {
    const attachment = this.props.attachmentToDelete
    if (attachment === null) {
      return null
    }

    const { onAttachmentDeleteClickedConfirm, attachmentToDelete, inUse, deleting, deleteError, ...props } = this.props

    let deletingIndicator: JSX.Element | string = ''
    if (deleting) {
      deletingIndicator = <Icon name="loading" spin />
    }
    if (deleteError) {
      deletingIndicator = <p>{this.props.deleteError}</p>
    }

    const renderAttachment = this.renderByFileFormat(attachment)

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
