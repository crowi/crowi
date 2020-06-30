import React from 'react'

import { createPatch } from 'diff'
import { html } from 'diff2html'

import { Revision } from 'client/types/crowi'

interface Props {
  currentRevision: Revision
  previousRevision: Revision
  revisionDiffOpened: boolean
}

const RevisionDiff: React.FC<Props> = ({ currentRevision, previousRevision, revisionDiffOpened }) => {
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

    diffViewHTML = html(patch, options)
  }

  const diffView = { __html: diffViewHTML }

  return <div className="revision-history-diff" dangerouslySetInnerHTML={diffView} />
}

export default RevisionDiff
