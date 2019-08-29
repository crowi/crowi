import React from 'react'
import UserDate from 'components/Common/UserDate'
import Icon from 'components/Common/Icon'
import UserPicture from 'components/User/UserPicture'
import { Revision as RevisionType } from 'client/types/crowi'

interface Props {
  revision: RevisionType
  onDiffOpenClicked: Function
}

export default class Revision extends React.Component<Props> {
  constructor(props: Props) {
    super(props)

    this._onDiffOpenClicked = this._onDiffOpenClicked.bind(this)
  }

  componentDidMount() {}

  _onDiffOpenClicked() {
    this.props.onDiffOpenClicked(this.props.revision)
  }

  render() {
    const revision = this.props.revision
    const author = revision.author
    const pic = <UserPicture user={author} />

    return (
      <div className="revision-history-main">
        {pic}
        <div className="revision-history-author">
          <strong>{author.username}</strong>
        </div>
        <div className="revision-history-meta">
          <p>
            <UserDate dateTime={revision.createdAt} />
          </p>
          <p>
            <a href={'?revision=' + revision._id}>
              <Icon name="history" /> View this version
            </a>
            <a className="diff-view" onClick={this._onDiffOpenClicked}>
              <Icon name="unfoldMoreHorizontal" /> View diff
            </a>
          </p>
        </div>
      </div>
    )
  }
}
