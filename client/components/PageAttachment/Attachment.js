// @flow
import React from 'react'

import Icon from 'components/Common/Icon'
import User from 'components/User/User'

type Props = {
  attachment: Object,
  inUse: boolean,
  onAttachmentDeleteClicked: Function,
}

export default class Attachment extends React.Component<Props> {
  iconNameByFormat(format: string) {
    if (format.match(/image\/.+/i)) {
      return 'file-image'
    }

    return 'file'
  }

  _onAttachmentDeleteClicked = (event: Event) => {
    this.props.onAttachmentDeleteClicked(this.props.attachment)
  }

  render() {
    const attachment = this.props.attachment
    const formatIcon = this.iconNameByFormat(attachment.fileFormat)

    let fileInUse = ''
    if (this.props.inUse) {
      fileInUse = <span className="attachment-in-use badge badge-info">In Use</span>
    }

    const fileType = <span className="attachment-filetype badge badge-secondary">{attachment.fileFormat}</span>

    return (
      <li>
        <User user={attachment.creator} />
        <Icon name={formatIcon} regular />

        <a href={attachment.url}> {attachment.originalName}</a>

        {fileType}

        {fileInUse}

        <a className="text-danger attachment-delete" onClick={this._onAttachmentDeleteClicked}>
          <Icon name="trash" solid />
        </a>
      </li>
    )
  }
}
