import React from 'react'

import { createPatch } from 'diff'
import { Diff2Html } from 'diff2html'

import { Revision } from 'client/types/crowi'

interface Props {
  currentRevision: Revision
  previousRevision: Revision
  revisionDiffOpened: boolean
}

export class RevisionDiff extends React.Component<Props> {
  render() {
    const { currentRevision, previousRevision, revisionDiffOpened } = this.props

    let diffViewHTML = ''
    if (currentRevision.body && previousRevision.body && revisionDiffOpened) {
      let previousText = previousRevision.body
      if (currentRevision._id == previousRevision._id) {
        previousText = ''
      }

      const patch = createPatch(currentRevision.path, previousText, currentRevision.body, '', '')

      diffViewHTML = Diff2Html.getPrettyHtml(patch)
    }

    const diffView = { __html: diffViewHTML }
    return <div className="revision-history-diff" dangerouslySetInnerHTML={diffView} />
  }
}
