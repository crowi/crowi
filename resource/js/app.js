import React from 'react';
import ReactDOM from 'react-dom';

import Crowi from './util/Crowi';
import CrowiRenderer from './util/CrowiRenderer';

import HeaderSearchBox  from './components/HeaderSearchBox';
import SearchPage  from './components/SearchPage';
import PageListSearch  from './components/PageListSearch';
import NotificationPage from './components/NotificationPage';
import HeaderNotification from './components/HeaderNotification';
import SeenUserList from './components/SeenUserList';

if (!window) {
  window = {};
}
// FIXME
const crowi = new Crowi({me: $('#content-main').data('current-username')}, window);
window.crowi = crowi;
crowi.fetchUsers();

const crowiRenderer = new CrowiRenderer();
window.crowiRenderer = crowiRenderer;

const me = $('body').data('me');
const componentMappings = {
  'search-top': <HeaderSearchBox />,
  'search-page': <SearchPage />,
  'page-list-search': <PageListSearch />,
  'notification-page': <NotificationPage />,
  //'page-comment': <PageComment />,
  'seen-user-list': <SeenUserList />,
  'header-notification': <HeaderNotification me={me} />,
};

Object.keys(componentMappings).forEach((key) => {
  const elem = document.getElementById(key);
  if (elem) {
    ReactDOM.render(componentMappings[key], elem);
  }
});
