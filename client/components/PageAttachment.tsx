import React from 'react'
import PageAttachmentList from './PageAttachment/PageAttachmentList'
import DeleteAttachmentModal from './PageAttachment/DeleteAttachmentModal'
import Crowi from 'client/util/Crowi'
import { Attachment } from 'client/types/crowi'

interface Props {
  pageId: string | null
  pageContent: string | null
  crowi: Crowi
}

interface State {
  attachments: Attachment[]
  inUse: { [id: string]: boolean }
  attachmentToDelete: Attachment | null
  deleting: boolean
  deleteError: string
}

export default class PageAttachment extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      attachments: [],
      inUse: {},
      attachmentToDelete: null,
      deleting: false,
      deleteError: '',
    }

    this.onAttachmentDeleteClicked = this.onAttachmentDeleteClicked.bind(this)
    this.onAttachmentDeleteClickedConfirm = this.onAttachmentDeleteClickedConfirm.bind(this)
  }

  componentDidMount() {
    const pageId = this.props.pageId

    if (!pageId) {
      return
    }

    this.props.crowi.apiGet('/attachments.list', { page_id: pageId }).then((res) => {
      const attachments: Attachment[] = res.attachments
      const inUse: State['inUse'] = {}

      for (const attachment of attachments) {
        inUse[attachment._id] = this.checkIfFileInUse(attachment)
      }

      this.setState({ attachments, inUse })
    })
  }

  checkIfFileInUse(attachment: Attachment) {
    const { pageContent } = this.props
    if (pageContent && pageContent.match(attachment.url)) {
      return true
    }
    return false
  }

  onAttachmentDeleteClicked(attachment: Attachment) {
    this.setState({
      attachmentToDelete: attachment,
    })
  }

  onAttachmentDeleteClickedConfirm(attachment: Attachment) {
    const attachmentId = attachment._id
    this.setState({
      deleting: true,
    })

    this.props.crowi
      .apiPost('/attachments.remove', { attachment_id: attachmentId })
      .then((res) => {
        this.setState({
          attachments: this.state.attachments.filter((at) => {
            return at._id != attachmentId
          }),
          attachmentToDelete: null,
          deleting: false,
        })
      })
      .catch((err) => {
        this.setState({
          deleteError: 'Something went wrong.',
          deleting: false,
        })
      })
  }

  render() {
    const { attachmentToDelete, attachments } = this.state
    const deleteModalClose = () => this.setState({ attachmentToDelete: null })
    const showModal = attachmentToDelete !== null

    let deleteInUse = false
    if (attachmentToDelete !== null) {
      deleteInUse = !!this.state.inUse[attachmentToDelete._id] || false
    }

    if (!attachments || attachments.length <= 0) {
      return null
    }

    return (
      <div className="page-meta-contents">
        <p className="page-meta-title">Attachments</p>
        <PageAttachmentList attachments={attachments} inUse={this.state.inUse} onAttachmentDeleteClicked={this.onAttachmentDeleteClicked} />
        <DeleteAttachmentModal
          isOpen={showModal}
          toggle={deleteModalClose}
          attachmentToDelete={attachmentToDelete}
          inUse={deleteInUse}
          deleting={this.state.deleting}
          deleteError={this.state.deleteError}
          onAttachmentDeleteClickedConfirm={this.onAttachmentDeleteClickedConfirm}
        />
      </div>
    )
  }
}
