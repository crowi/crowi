import React from 'react';

import Icon from './Common/Icon';
import PageAttachmentList from './PageAttachment/PageAttachmentList';
import DeleteAttachmentModal from './PageAttachment/DeleteAttachmentModal';

export default class PageAttachment extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      attachments: [],
      inUse: {},
      attachmentToDelete: null,
      deleting: false,
      deleteError: '',
    };

    this.onAttachmentDeleteClicked = this.onAttachmentDeleteClicked.bind(this);
    this.onAttachmentDeleteClickedConfirm = this.onAttachmentDeleteClickedConfirm.bind(this);
  }

  componentDidMount() {
    const pageId = this.props.pageId;

    if (!pageId) {
      return ;
    }

    this.props.crowi.apiGet('/attachments.list', {page_id: pageId })
    .then(res => {
      const attachments = res.attachments;
      let inUse = {};

      for (const attachment of attachments) {
        inUse[attachment._id] = this.checkIfFileInUse(attachment);
      }

      this.setState({
        attachments: attachments,
        inUse: inUse,
      });
    });
  }

  checkIfFileInUse(attachment) {
    if (this.props.pageContent.match(attachment.url)) {
      return true;
    }
    return false;
  }

  onAttachmentDeleteClicked(attachment) {
    this.setState({
      attachmentToDelete: attachment,
    });
  }

  onAttachmentDeleteClickedConfirm(attachment) {
    const attachmentId = attachment._id;
    this.setState({
      deleting: true,
    });

    this.props.crowi.apiPost('/attachments.remove', {attachment_id: attachmentId})
    .then(res => {
      this.setState({
        attachments: this.state.attachments.filter((at) => {
          return at._id != attachmentId;
        }),
        attachmentToDelete: null,
        deleting: false,
      });
    }).catch(err => {
      this.setState({
        deleteError: 'Something went wrong.',
        deleting: false,
      });
    });
  }

  isUserLoggedIn() {
    return this.props.crowi.me !== '';
  }

  render() {
    let deleteAttachmentModal = '';
    if (this.isUserLoggedIn()) {
      const attachmentToDelete = this.state.attachmentToDelete;
      let deleteModalClose = () => this.setState({ attachmentToDelete: null });
      let showModal = attachmentToDelete !== null;

      let deleteInUse = null;
      if (attachmentToDelete !== null) {
        deleteInUse = this.state.inUse[attachmentToDelete._id] || false;
      }

      deleteAttachmentModal = (
        <DeleteAttachmentModal
          show={showModal}
          animation={false}
          onHide={deleteModalClose}

          attachmentToDelete={attachmentToDelete}
          inUse={deleteInUse}
          deleting={this.state.deleting}
          deleteError={this.state.deleteError}
          onAttachmentDeleteClickedConfirm={this.onAttachmentDeleteClickedConfirm}
        />
      );
    }


    return (
      <div>
        <p>Attachments</p>
        <PageAttachmentList
          attachments={this.state.attachments}
          inUse={this.state.inUse}
          onAttachmentDeleteClicked={this.onAttachmentDeleteClicked}
          isUserLoggedIn={this.isUserLoggedIn()}
        />

        {deleteAttachmentModal}
      </div>
    );
  }
}
