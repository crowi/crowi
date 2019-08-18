import React, { useState, useEffect, FC } from 'react'
import styled from 'styled-components'
import { CommonProps } from 'client/types/component'

import { Container, Row, Col } from 'reactstrap'
import ReactMarkdown from 'react-markdown'
import { Page as PageType } from 'client/types/crowi'

interface Props {
  page: PageType
}

// function usePage(crowi: Crowi) {}
const EditorCol = styled(Col)`
  padding: 0;
`

const EditorInput = styled.div`
  height: 100%;
  padding: 1em;
  font-family: menlo, monaco, consolas, monospace;
`

const EditorForm: FC<Props> = ({ page }) => {
  const [pageBody, setPageBody] = useState(page.revision.body)

  const onChange = e => {
    setPageBody(e.target.innerHTML)
  }

  return (
    <EditorCol md="6">
      <EditorInput
        onInput={onChange}
        onBlur={onChange}
        contentEditable
        suppressContentEditableWarning
        dangelouslySetInnerHtml={{ __html: pageBody + `<div style="font-color: #fff">hoge</div>` }}
      ></EditorInput>
    </EditorCol>
  )
}

export default EditorForm
