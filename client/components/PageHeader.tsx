import React, { FC, useState, useEffect } from 'react'
import styled from 'styled-components'
import Crowi from 'client/util/Crowi'
import { CommonProps } from 'client/types/component'
import { Page as PageType } from 'client/types/crowi'

const Header = styled.div<Props>`
  margin: 8px 0 0 0;
  display: flex;
  position: relative;
  width: 100%;

  ${(props) =>
    props.isScrolling &&
    `
    width: 100vw;
    @include media-breakpoint-up(md) {
      width: 100%;
    }
  `}
`

const Stopper = styled.div<{ isStopperShown: boolean }>`
  display: block;
  position: absolute;
  bottom: -32px;
  width: 40px;
  height: 32px;
  line-height: 32px;
  right: 10px;
  background: #fff;
  margin: 0;
  border: solid 1px #ccc;
  border-top: none;
  border-radius: 0 0 5px 5px;
  font-size: 0.8em;
  text-align: center;
  cursor: pointer;
`

type Props = CommonProps & {
  crowi: Crowi
  pageId: string | null
  revisionId: string | null
}

/*

<div class="header-wrap sps sps--abv">
  {% if not page.isDeleted() %}
  <header id="page-header">
    <p class="stopper">{{ Icon("chevronUp") }}</p>


    <div class="flex-title-line">
      <h1 class="title flex-item-title" id="revision-path">
        {{ path|insertSpaceToEachSlashes }}

        <div class="btn-group page-links" role="group">
          <button type="button" class="btn btn-secondary-outline">
            {{ Icon("contentCopy") }}
          </button>
          <div class="btn-group" role="group">
            <button id="linkCopyButtonGroup" type="button" class="btn btn-secondary-outline dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
            </button>
            <div class="dropdown-menu" aria-labelledby="linkCopyButtonGroup">
              <a class="dropdown-item" href="#">
                {{ Icon("link") }}
              </a>
              <a class="dropdown-item" href="#">
                {{ Icon("languageMarkdown") }}
              </a>
            </div>
          </div>
        </div>
      </h1>
      {# <input readonly class="copy-link form-control" type="text" value="{{ config.crowi['app:title']|default('Crowi') }} {{ path }}  {{ baseUrl }}/{{ page._id.toString() }}"> #}
      {% if page %}

      <div class="flex-item-action">
        <span id="bookmark-button">
          <p class="bookmark-link">
            {{ Icon("starOutline") }}
          </p>
        </span>
      </div>
      <div class="flex-item-action d-md-none">
        <button
            data-liked="{% if page.isLiked(user) %}1{% else %}0{% endif %}"
            class="like-button btn btn-outline-secondary btn-sm {% if page.isLiked(user) %}active{% endif %}"
        >{{ Icon("thumbUpOutline") }}</button>
      </div>
      {% endif %}
    </div>
  </header>
  {% else %}
  {# trash/* #}
  <header id="page-header">
    <div class="flex-title-line">
      <h1 class="title flex-item-title">{{ path|insertSpaceToEachSlashes }}</h1>
      <div class="flex-item-action">
        <span id="bookmark-button">
          <p class="bookmark-link">
            {{ Icon("starOutline") }}
          </a>
        </span>
      </div>
    </div>
  </header>
  {% endif %}
</div>
<div class="dummy-header-wrap"></div>
*/

function useFetchPage(crowi: Crowi, pageId: string | null, revisionId: string | null) {
  const [page, setPage] = useState<PageType | null>(null)

  const fetchPage = async () => {
    if (!pageId) {
      return
    }

    const { ok, page } = await crowi.apiGet('/pages.get', { page_id: pageId, revision_id: revisionId })
    if (ok) {
      setPage(page)
    } else {
      throw new Error('Failed to fetch page')
    }
  }

  return [page, fetchPage] as const
}

function useStickyHeader(crowi: Crowi) {
  const [isStickyHeader, setIsStickyHeader] = useState<boolean>(false)
  const [isStopperShown, setIsStopperShown] = useState<boolean>(true)

  return [isStickyHeader, isStopperShown, setIsStopperShown]
}

function insertSpaceToEachSlashes(path: string): string {
  if (path === '/') {
    return path
  }

  return path.replace(/\//g, ' / ')
}

const PageHeader: FC<Props> = (props) => {
  const { crowi, pageId, revisionId, ...others } = props
  const [page, fetchPage] = useFetchPage(crowi, pageId, revisionId)
  const [isStickyHeader, isStopperShwon, setIsStopperShown] = useStickyHeader(crowi)
  // const [{ posting, message }, { postComment }] = usePostComment(crowi, pageId, revisionId, fetchComments)

  useEffect(() => {
    fetchPage()
  }, [])

  if (!page) {
    return null
  }

  const pagePath = insertSpaceToEachSlashes(page?.path)

  return (
    <Header {...others}>
      <header id="page-header">{pagePath}</header>
      <Stopper isStopperShown></Stopper>
    </Header>
  )
}

export default PageHeader
