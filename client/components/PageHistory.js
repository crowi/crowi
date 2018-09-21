// @flow
import React from 'react'

import Icon from './Common/Icon'
import PageRevisionList from './PageHistory/PageRevisionList'

type Props = {
  pageId?: string,
  crowi: Object,
}

type State = {
  revisions: Array<Object>,
  diffOpened: Object,
}

export default class PageHistory extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      revisions: [],
      diffOpened: {},
    }
  }

  componentDidMount() {
    const pageId = this.props.pageId

    if (!pageId) {
      return
    }

    this.props.crowi
      .apiGet('/revisions.ids', { page_id: pageId })
      .then(res => {
        const rev = res.revisions
        let diffOpened = {}
        const lastId = rev.length - 1
        res.revisions.map((revision, i) => {
          const user = this.props.crowi.findUserById(revision.author)
          if (user) {
            rev[i].author = user
          }

          if (i === 0 || i === lastId) {
            diffOpened[revision._id] = true
          } else {
            diffOpened[revision._id] = false
          }
        })

        this.setState({
          revisions: rev,
          diffOpened: diffOpened,
        })

        // load 0, and last default
        if (rev[0]) {
          this.fetchPageRevisionBody(rev[0])
        }
        if (rev[1]) {
          this.fetchPageRevisionBody(rev[1])
        }
        if (lastId !== 0 && lastId !== 1 && rev[lastId]) {
          this.fetchPageRevisionBody(rev[lastId])
        }
      })
      .catch(err => {
        // do nothing
      })
  }

  getPreviousRevision = (currentRevision: Object): Object => {
    let cursor = null
    for (let revision of this.state.revisions) {
      if (cursor && cursor._id == currentRevision._id) {
        cursor = revision
        break
      }

      cursor = revision
    }

    return cursor || {}
  }

  onDiffOpenClicked = (revision: Object) => {
    const diffOpened = this.state.diffOpened
    const revisionId = revision._id

    if (diffOpened[revisionId]) {
      return
    }

    diffOpened[revisionId] = true
    this.setState({
      diffOpened,
    })

    this.fetchPageRevisionBody(revision)
    this.fetchPageRevisionBody(this.getPreviousRevision(revision))
  }

  fetchPageRevisionBody(revision: Object) {
    if (revision.body) {
      return
    }

    this.props.crowi
      .apiGet('/revisions.get', { revision_id: revision._id })
      .then(res => {
        if (res.ok) {
          this.setState({
            revisions: this.state.revisions.map(rev => {
              if (rev._id == res.revision._id) {
                return res.revision
              }

              return rev
            }),
          })
        }
      })
      .catch(err => {})
  }

  render() {
    return (
      <div>
        <h1>
          <Icon name="history" /> History
        </h1>
        <PageRevisionList revisions={this.state.revisions} diffOpened={this.state.diffOpened} onDiffOpenClicked={this.onDiffOpenClicked} />
      </div>
    )
  }
}
