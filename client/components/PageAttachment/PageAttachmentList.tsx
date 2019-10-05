import React from 'react'
import { Attachment } from 'components/PageAttachment/Attachment'
import { Attachment as AttachmentType } from 'client/types/crowi'

interface Props {
  attachments: AttachmentType[]
  inUse: { [id: string]: boolean }
  onAttachmentDeleteClicked: Function
}

export class PageAttachmentList extends React.Component<Props> {
  render() {
    if (this.props.attachments.length === 0) {
      return null
    }

    const attachmentList = this.props.attachments.map(attachment => {
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
