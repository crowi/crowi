// @flow
import React from 'react'

import { createPatch } from 'diff'
import { Diff2Html } from 'diff2html'

type Props = {
  currentRevision: Object,
  previousRevision: Object,
  revisionDiffOpened: boolean,
}

export default class RevisionDiff extends React.Component<Props> {
  render() {
    const currentRevision = this.props.currentRevision
    const previousRevision = this.props.previousRevision
    const revisionDiffOpened = this.props.revisionDiffOpened

    let diffViewHTML = ''
    if (currentRevision.body && previousRevision.body && revisionDiffOpened) {
      let previousText = previousRevision.body
      if (currentRevision._id == previousRevision._id) {
        previousText = ''
      }

      const patch = createPatch(currentRevision.path, previousText, currentRevision.body)

      diffViewHTML = Diff2Html.getPrettyHtml(patch)
    }

    const diffView = { __html: diffViewHTML }
    return <div className="revision-history-diff" dangerouslySetInnerHTML={diffView} />
  }
}
