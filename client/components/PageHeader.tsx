import React, { FC, useState, useEffect, useRef } from 'react'
import styled from 'styled-components'
import Crowi from 'client/util/Crowi'
import { CommonProps } from 'client/types/component'
import { Page as PageType } from 'client/types/crowi'

import { Tooltip, InputGroup, InputGroupAddon, Button, Input } from 'reactstrap'

import Icon from 'client/components/Common/Icon'
import BookmarkButton from './BookmarkButton'

const ShareToolContainer = styled.div`
  display: ${(props) => (props.isShareToolOpen && `flex`) || `none`};
  z-index: 1010;
  border: none;
  box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.1), 0px 8px 20px rgba(0, 0, 0, 0.2);
  position: absolute;
  top: 2em;
  background: #fff;
  padding: 1rem;
  border-radius: 0.25rem;
  right: 0;
  width: 50vw;
  max-width: 400px;
`

const SharableValueInput = styled.div`
  position: absolute;
  left: -9999px;
`

const ShareTool = styled.div`
  margin-left: 0.5em;
  position: relative;
  transition: 0.2s;
  cursor: pointer;
  flex: 1;
  display: flex;
  flex-wrap: nowrap;

  > button {
    color: transparent;
    border: none;
    background: none;
    margin: inherit;
    padding: inherit;
  }
`

const Header = styled.div<Props>`
  margin: 8px 0 0 0;
  display: flex;
  align-items: center;
  position: relative;
  width: 100%;
  padding: .5em 1em 1em;

  ${(props) =>
    props.isScrolling &&
    `
    width: 100vw;
    @include media-breakpoint-up(md) {
      width: 100%;
    }
  `}

  &:hover ${ShareTool} {
    button {
      color: #888;
    }
  }
`

const PagePath = styled.h1`
  font-size: 28px;
  line-height: 1;
  margin: 0;
`

const Stopper = styled.div<{ isStopperShown: boolean }>`
  display: ${(props) => (props.isStopperShown && `block`) || `none`};
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

function handleCopy(e: React.MouseEvent<HTMLElement, MouseEvent>, ref, crowi: Crowi) {
  const document = crowi.document
  ref.current.select()
  document.execCommand('copy')
}

function buildSharableUrl(page: PageType, crowi: Crowi) {
  const context = crowi.getContext()

  return `${context.url}/${page._id}`
}

const PathLink = styled.a<{ lastPath?: boolean }>`
  ${(props) =>
    props.lastPath &&
    `
    color: #D1E2E4;
    opacity: .4;

    &:hover {
      color: inherit;
    }
  `}
`

function createPathLinks(pagePath: string) {
  let realPath = pagePath.trim()
  if (realPath.substr(-1, 1) == '/') {
    realPath = realPath.substr(0, realPath.length - 1)
  }

  const pathComponents: React.ReactNode[] = []

  let buildingPath = ''
  const splittedPath = realPath.split(/\//)
  splittedPath.shift()
  splittedPath.map((subPath: string) => {
    buildingPath += `/`
    pathComponents.push(
      <PathLink key={buildingPath} href={buildingPath}>
        {' '}
        /{' '}
      </PathLink>,
    )
    buildingPath += subPath.replace(' ', '+')
    pathComponents.push(
      <PathLink key={buildingPath} href={buildingPath}>
        {subPath}
      </PathLink>,
    )
  })

  buildingPath += `/`
  pathComponents.push(
    <PathLink lastPath key={buildingPath} href={buildingPath}>
      {' '}
      /{' '}
    </PathLink>,
  )

  return pathComponents
}

const PageHeader: FC<Props> = (props) => {
  const { crowi, pageId, revisionId, ...others } = props
  const [page, fetchPage] = useFetchPage(crowi, pageId, revisionId)
  const [isStickyHeader, isStopperShown, setIsStopperShown] = useStickyHeader(crowi)
  // const [{ posting, message }, { postComment }] = usePostComment(crowi, pageId, revisionId, fetchComments)

  const [hoverShareToolCopy, setHoverShareToolCopy] = useState<boolean>(false)
  const [hoverCopiedMessage, setHoverCopiedMessage] = useState<boolean>(false)
  const [isShareToolOpen, setIsShareToolOpen] = useState<boolean>(false)

  const defaultSharablePageRef = useRef(null)
  let urlOnlySharablePageRef
  let markdownSharablePageRef

  useEffect(() => {
    fetchPage()
  }, [])

  if (!page) {
    return null
  }

  const toggle = () => {}
  const dropdownOpen = false

  const pagePath = insertSpaceToEachSlashes(page?.path)

  return (
    <Header isStickyHeader={isStickyHeader} {...others}>
      <PagePath>{createPathLinks(page.path)}</PagePath>

      <ShareTool>
        <SharableValueInput>
          <input type="text" value={buildSharableUrl(page, crowi)} ref={defaultSharablePageRef} readOnly aria-hidden="true" tab-index="-1" />
        </SharableValueInput>
        <Tooltip placement="bottom" isOpen={hoverShareToolCopy} target="pageUrlCopyIcon">
          Copy link to this page
        </Tooltip>
        <Tooltip placement="bottom" isOpen={hoverCopiedMessage} target="pageUrlCopyIcon">
          Copied!
        </Tooltip>
        <button
          onMouseEnter={() => {
            setHoverShareToolCopy(true)
          }}
          onMouseLeave={() => {
            setHoverShareToolCopy(false)
          }}
          onClick={(e) => {
            handleCopy(e, defaultSharablePageRef, crowi)
            setHoverShareToolCopy(false)
            setHoverCopiedMessage(true)
            setInterval(() => {
              setHoverCopiedMessage(false)
            }, 2000)
          }}
          id="pageUrlCopyIcon"
        >
          <Icon name="link" />
        </button>
        <button
          onClick={() => {
            setIsShareToolOpen(true)
          }}
        >
          <Icon name="menuDown" />
        </button>
        <ShareToolContainer isShareToolOpen={isShareToolOpen}>
          <InputGroup size="sm">
            <InputGroupAddon addonType="prepend">
              <Icon name="fileLinkOutline" />
            </InputGroupAddon>
            <Input placeholder="and..." />
            <InputGroupAddon addonType="append">
              <Button color="secondary">
                <Icon name="contentCopy" />
              </Button>
            </InputGroupAddon>
          </InputGroup>

          <InputGroup size="sm">
            <InputGroupAddon addonType="prepend">@hoge</InputGroupAddon>
            <Input placeholder="and..." />
            <InputGroupAddon addonType="append">
              <Button color="secondary">
                <Icon name="contentCopy" />
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </ShareToolContainer>
      </ShareTool>

      <BookmarkButton pageId={page._id} crowi={crowi} />

      <Stopper isStopperShown></Stopper>
    </Header>
  )
}

export default PageHeader
