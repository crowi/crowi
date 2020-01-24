import React from 'react'
import ReactDOM from 'react-dom'

import i18n from './i18n'

import Crowi from './util/Crowi'
import CrowiRenderer from './util/CrowiRenderer'
import CrowiAuth from './util/CrowiAuth'
import Emitter from './emitter'

import SideMenuTrigger from 'components/SideMenuTrigger'
import HeaderSearchBox from 'components/HeaderSearchBox'
import SearchPage from 'components/SearchPage'
import PageCreateModal from 'client/components/Modal/PageCreateModal'
import PageDeleteModal from 'components/Modal/PageDeleteModal'
import PageListSearch from 'components/PageListSearch'
import PageHistory from 'components/PageHistory'
import PageAttachment from 'components/PageAttachment'
import PageAlerts from 'components/PageAlerts'
import SeenUserList from 'components/SeenUserList'
import BookmarkButton from 'components/BookmarkButton'
import ShareBox from 'components/ExternalShare/ShareBox'
import SecretKeywordFormContainer from 'components/ExternalShare/SecretKeywordForm/SecretKeywordFormContainer'
import RenameTree from 'components/RenameTree/RenameTree'
import Backlink from './components/Backlink'
import NotificationPage from 'components/NotificationPage'
import HeaderNotification from 'components/HeaderNotification'
import WatchButton from 'components/Notification/WatchButton'
import AdminShare from 'components/Admin/Share/AdminShare'
import Comment from 'components/Comment/Comment'
import AdminPage from 'components/Admin/AdminPage'
import HelpPortalModal from 'components/Help/HelpPortalModal/HelpPortalModal'

import hydrateComponents from './hydrateComponents'

i18n()

const mainContent = document.querySelector('#content-main')
let pageId: string | null = null
let revisionId: string | null = null
let revisionCreatedAt: string | null = null
let pageContent: string | null = null
if (mainContent !== null) {
  pageId = mainContent.getAttribute('data-page-id')
  revisionId = mainContent.getAttribute('data-page-revision-id')
  revisionCreatedAt = mainContent.getAttribute('data-page-revision-created')
  const rawText = document.getElementById('raw-text-original')
  if (rawText) {
    pageContent = rawText.innerHTML
  }
}

const getTextContent = (element: HTMLElement | null) => (element ? element.textContent : null)

const { user = {} } = JSON.parse(getTextContent(document.getElementById('user-context-hydrate')) || '{}')
const csrfToken = $('#content-main').data('csrftoken') || $('#admin-page').data('csrftoken')
// FIXME
const crowi = new Crowi({ user, csrfToken }, window)
window.crowi = crowi
crowi.setConfig(JSON.parse(getTextContent(document.getElementById('crowi-context-hydrate')) || '{}'))
const isSharePage = !!$('#content-main').data('is-share-page') || !!$('#secret-keyword-form-container').data('share-id')
if (!isSharePage) {
  crowi.fetchUsers()
}

const crowiRenderer = new CrowiRenderer(crowi)
window.crowiRenderer = crowiRenderer

const crowiAuth = new CrowiAuth(crowi)
window.crowiAuth = crowiAuth

const me = $('body').data('me')
const componentMappings = {
  'page-create-modal': <PageCreateModal crowi={crowi} />,
  'page-delete-modal': <PageDeleteModal crowi={crowi} pageId={pageId} revisionId={revisionId} />,
  'side-menu-trigger': <SideMenuTrigger crowi={crowi} />,
  'search-top': <HeaderSearchBox crowi={crowi} />,
  'search-page': <SearchPage crowi={crowi} />,
  'page-list-search': <PageListSearch crowi={crowi} />,
  'page-attachment': <PageAttachment pageId={pageId} pageContent={pageContent} crowi={crowi} />,
  'page-alerts': <PageAlerts pageId={pageId} crowi={crowi} />,
  'rename-tree': <RenameTree crowi={crowi} />,
  'header-notification': <HeaderNotification me={me} crowi={crowi} />,
  'notification-page': <NotificationPage crowi={crowi} />,

  // 'revision-history': <PageHistory pageId={pageId} />,
  'backlink-list': <Backlink pageId={pageId} crowi={crowi} />,
  'seen-user-list': <SeenUserList crowi={crowi} />,
  'bookmark-button': <BookmarkButton pageId={pageId} crowi={crowi} />,
  'share-box': <ShareBox pageId={pageId} crowi={crowi} />,
  'secret-keyword-form-container': <SecretKeywordFormContainer crowi={crowi} />,
  'watch-button': <WatchButton pageId={pageId} crowi={crowi} />,
  'admin-share': <AdminShare crowi={crowi} />,
  'page-comments': <Comment crowi={crowi} pageId={pageId} revisionId={revisionId} revisionCreatedAt={revisionCreatedAt} isSharePage={isSharePage} />,
  'admin-page': <AdminPage crowi={crowi} />,

  'help-portal': <HelpPortalModal />,
}

Object.entries(componentMappings).forEach(([key, component]) => {
  const elem = document.getElementById(key)
  if (elem) {
    ReactDOM.render(component, elem)
  }
})

// TODO: remove this logic after migrate to React
const closeSideMenuHandler = e => {
  Emitter.emit('closeSideMenu')
}
Emitter.on('sideMenuHandle', isOpen => {
  const closeTriggerElements = ['crowi-global-menu', 'v2-container-backdrop']
  const containerElement = document.getElementById('crowi-main-container')
  const menuClassName = ' side-menu-open'
  if (containerElement) {
    if (isOpen) {
      containerElement.className += menuClassName
      for (const elemName of closeTriggerElements) {
        const e = document.getElementById(elemName)
        if (e) {
          e.addEventListener('click', closeSideMenuHandler)
        }
      }
    } else {
      containerElement.className = containerElement.className.replace(menuClassName, '')
      for (const elemName of closeTriggerElements) {
        const e = document.getElementById(elemName)
        if (e) {
          e.removeEventListener('click', closeSideMenuHandler)
        }
      }
    }
  }
})

hydrateComponents()

// うわーもうー
$('a[data-toggle="tab"][href="#revision-history"]').on('show.bs.tab', function() {
  ReactDOM.render(<PageHistory pageId={pageId} crowi={crowi} />, document.getElementById('revision-history'))
})
