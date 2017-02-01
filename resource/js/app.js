import React from 'react';
import ReactDOM from 'react-dom';

import Crowi from './util/Crowi';
import CrowiRenderer from './util/CrowiRenderer';

import HeaderSearchBox  from './components/HeaderSearchBox';
import SearchPage  from './components/SearchPage';
import PageListSearch  from './components/PageListSearch';
//import PageComment  from './components/PageComment';
import SeenUserList from './components/SeenUserList';
import Backlink from './components/Backlink';

if (!window) {
  window = {};
}
// FIXME
const crowi = new Crowi({me: $('#content-main').data('current-username')}, window);
window.crowi = crowi;
crowi.fetchUsers();

const crowiRenderer = new CrowiRenderer();
window.crowiRenderer = crowiRenderer;

const contentMain = document.querySelector('#content-main');
let pageId = null;
if (contentMain !== null) {
  pageId = contentMain.dataset.pageId;
}

const componentMappings = {
  'search-top': <HeaderSearchBox />,
  'search-page': <SearchPage />,
  'page-list-search': <PageListSearch />,
  //'page-comment': <PageComment />,
  'seen-user-list': <SeenUserList />,
  'backlink-list': <Backlink pageId={pageId} crowi={crowi} />,
};

Object.keys(componentMappings).forEach((key) => {
  const elem = document.getElementById(key);
  if (elem) {
    ReactDOM.render(componentMappings[key], elem);
  }
});
