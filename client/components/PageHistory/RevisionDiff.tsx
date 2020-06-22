import React from 'react'

import { createPatch } from 'diff'
import * as Diff2Html from 'diff2html'

import { Revision } from 'client/types/crowi'

interface Props {
  currentRevision: Revision
  previousRevision: Revision
  revisionDiffOpened: boolean
}

export default class RevisionDiff extends React.Component<Props> {
  render() {
    const { currentRevision, previousRevision, revisionDiffOpened } = this.props

    let diffViewHTML = ''
    if (currentRevision.body && previousRevision.body && revisionDiffOpened) {
      let previousText = previousRevision.body
      if (currentRevision._id == previousRevision._id) {
        previousText = ''
      }

      const patch = createPatch(currentRevision.path, previousText, currentRevision.body, '', '')

      const options = {
        drawFileList: false,
      }

      diffViewHTML = Diff2Html.html(patch, options)
    }

    const diffView = { __html: diffViewHTML }
    return <div className="revision-history-diff" dangerouslySetInnerHTML={diffView} />
  }
}
