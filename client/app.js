import React from 'react'
import ReactDOM from 'react-dom'

import i18n from './i18n'
import moment from 'moment'

import Crowi from './util/Crowi'
import CrowiRenderer from './util/CrowiRenderer'
import CrowiAuth from './util/CrowiAuth'

import HeaderSearchBox from 'components/HeaderSearchBox'
import SearchPage from 'components/SearchPage'
import PageListSearch from 'components/PageListSearch'
import PageHistory from 'components/PageHistory'
import PageAttachment from 'components/PageAttachment'
import PageAlerts from 'components/PageAlerts'
import SeenUserList from 'components/SeenUserList'
import BookmarkButton from 'components/BookmarkButton'
import ShareBox from 'components/ExternalShare/ShareBox'
import SecretKeywordFormContainer from 'components/ExternalShare/SecretKeywordForm/SecretKeywordFormContainer'
import AdminShare from 'components/Admin/Share/AdminShare'
import RenameTree from 'components/RenameTree/RenameTree'

if (!window) {
  window = {}
}

i18n()

moment.locale(navigator.userLanguage || navigator.language)

const mainContent = document.querySelector('#content-main')
let pageId = null
let pageContent = null
if (mainContent !== null) {
  pageId = mainContent.attributes['data-page-id'].value
  const rawText = document.getElementById('raw-text-original')
  if (rawText) {
    pageContent = rawText.innerHTML
  }
}

const { user = {} } = JSON.parse(document.getElementById('user-context-hydrate').textContent || '{}')
const csrfToken = $('#content-main').data('csrftoken')
// FIXME
const crowi = new Crowi({ user, csrfToken }, window)
window.crowi = crowi
crowi.setConfig(JSON.parse(document.getElementById('crowi-context-hydrate').textContent || '{}'))
const isSharePage = !!$('#content-main').data('is-share-page') || !!$('#secret-keyword-form-container').data('share-id')
if (!isSharePage) {
  crowi.fetchUsers()
}

const crowiRenderer = new CrowiRenderer(crowi)
window.crowiRenderer = crowiRenderer

const crowiAuth = new CrowiAuth(crowi)
window.crowiAuth = crowiAuth

const componentMappings = {
  'search-top': <HeaderSearchBox crowi={crowi} />,
  'search-page': <SearchPage crowi={crowi} />,
  'page-list-search': <PageListSearch crowi={crowi} />,
  'page-attachment': <PageAttachment pageId={pageId} pageContent={pageContent} crowi={crowi} />,
  'page-alerts': <PageAlerts pageId={pageId} crowi={crowi} />,
  'rename-tree': <RenameTree pageId={pageId} crowi={crowi} />,

  // 'revision-history': <PageHistory pageId={pageId} />,
  // 'page-comment': <PageComment />,
  'seen-user-list': <SeenUserList pageId={pageId} crowi={crowi} />,
  'bookmark-button': <BookmarkButton pageId={pageId} crowi={crowi} />,
  'share-box': <ShareBox pageId={pageId} crowi={crowi} />,
  'secret-keyword-form-container': <SecretKeywordFormContainer pageId={pageId} crowi={crowi} />,
  'admin-share': <AdminShare pageId={pageId} crowi={crowi} />,
}

Object.keys(componentMappings).forEach(key => {
  const elem = document.getElementById(key)
  if (elem) {
    ReactDOM.render(componentMappings[key], elem)
  }
})

// うわーもうー
$('a[data-toggle="tab"][href="#revision-history"]').on('show.bs.tab', function() {
  ReactDOM.render(<PageHistory pageId={pageId} crowi={crowi} />, document.getElementById('revision-history'))
})
