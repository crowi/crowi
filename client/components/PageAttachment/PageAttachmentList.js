// @flow
import React from 'react'

import Attachment from './Attachment'

type Props = {
  attachments?: Array<Object>,
  inUse: Object,
  onAttachmentDeleteClicked: Function,
}

export default class PageAttachmentList extends React.Component<Props> {
  render() {
    const { attachments = [] } = this.props
    if (attachments.length === 0) {
      return null
    }

    const attachmentList = attachments.map((attachment, idx) => {
      return (
        <Attachment
          key={'page:attachment:' + attachment._id}
          attachment={attachment}
          inUse={this.props.inUse[attachment._id] || false}
          onAttachmentDeleteClicked={this.props.onAttachmentDeleteClicked}
        />
      )
    })

    return <ul>{attachmentList}</ul>
  }
}
