import React, { useState, useEffect, FC } from 'react'
import styled from 'styled-components'
import { CommonProps } from 'client/types/component'

import UserPicture from './User/UserPicture'
import EditorForm from './Editor/EditorForm'
import Crowi from 'client/util/Crowi'
import { Container, Row, Col } from 'reactstrap'
import ReactMarkdown from 'react-markdown'
import { Page as PageType } from 'client/types/crowi'

interface Props {
  crowi: Crowi
  pageId: string | null
}

const FullScreenRow = styled(Row)`
  height: 100vh;
`

function usePage(crowi: Crowi) {}

const Editor: FC<Props> = ({ crowi, pageId }) => {
  const [page, setPage] = useState()

  useEffect(() => {
    const fetchPage = async pageId => {
      try {
        const res = await crowi.apiGet('/pages.get', { page_id: pageId })
        console.log(res)
        if (res.ok) {
          console.log(res.page)
          setPage(res.page)
        }
      } catch (e) {
        console.log('Error', e)
      }
    }

    if (!page) {
      fetchPage(pageId)
    }
  })

  if (!page) {
    return <span>...</span>
  }

  return (
    <Container fluid>
      <FullScreenRow>
        <EditorForm page={page} />
        <Col md="6">
          <ReactMarkdown source={page.revision.body} className="wiki" />
        </Col>
      </FullScreenRow>
    </Container>
  )
}

export default Editor
