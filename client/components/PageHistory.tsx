import React from 'react'
import Icon from './Common/Icon'
import PageRevisionList from './PageHistory/PageRevisionList'
import Crowi from 'client/util/Crowi'
import { Revision } from 'client/types/crowi'

interface Props {
  pageId: string | null
  crowi: Crowi
}

interface State {
  revisions: Revision[]
  diffOpened: { [id: string]: boolean }
}

export default class PageHistory extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)

    this.state = {
      revisions: [],
      diffOpened: {},
    }

    this.getPreviousRevision = this.getPreviousRevision.bind(this)
    this.onDiffOpenClicked = this.onDiffOpenClicked.bind(this)
  }

  componentDidMount() {
    const pageId = this.props.pageId

    if (!pageId) {
      return
    }

    this.props.crowi
      .apiGet('/revisions.ids', { page_id: pageId })
      .then((res) => {
        const rev: Revision[] = res.revisions
        const diffOpened: State['diffOpened'] = {}
        const lastId = rev.length - 1
        res.revisions.map((revision: Revision, i: number) => {
          const author = typeof revision.author === 'string' ? revision.author : revision.author._id
          const user = this.props.crowi.findUserById(author)
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
      .catch((err) => {
        // do nothing
      })
  }

  getPreviousRevision(currentRevision: Revision) {
    let cursor: Revision | null = null
    for (const revision of this.state.revisions) {
      if (cursor && cursor._id == currentRevision._id) {
        cursor = revision
        break
      }

      cursor = revision
    }

    return cursor
  }

  onDiffOpenClicked(revision: Revision) {
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

  fetchPageRevisionBody(revision: Revision | null) {
    if (!revision) return
    if (revision.body) return

    this.props.crowi
      .apiGet('/revisions.get', { revision_id: revision._id })
      .then((res) => {
        if (res.ok) {
          this.setState({
            revisions: this.state.revisions.map((rev) => {
              if (rev._id == res.revision._id) {
                return res.revision
              }

              return rev
            }),
          })
        }
      })
      .catch((err) => {})
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
