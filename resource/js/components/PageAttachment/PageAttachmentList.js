import React from 'react';

import Attachment from './Attachment';

export default class PageAttachmentList extends React.Component {

  render() {
    if (this.props.attachments <= 0) {
      return null;
    }

    const attachmentList = this.props.attachments.map((attachment, idx) => {
      return (
        <Attachment
          key={"page:attachment:" + attachment._id}
          attachment={attachment}
          inUse={this.props.inUse[attachment._id] || false}
          onAttachmentDeleteClicked={this.props.onAttachmentDeleteClicked}
          isUserLoggedIn={this.props.isUserLoggedIn}
         />
      );
    });

    return (
      <ul>
        {attachmentList}
      </ul>
    );
  }
}

