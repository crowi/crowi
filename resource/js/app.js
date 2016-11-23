import React from 'react';
import ReactDOM from 'react-dom';

import Crowi from './util/Crowi';
import CrowiRenderer from './util/CrowiRenderer';

import HeaderSearchBox  from './components/HeaderSearchBox';
import SearchPage  from './components/SearchPage';
import PageListSearch  from './components/PageListSearch';
//import PageComment  from './components/PageComment';
import NotificationPage from './components/NotificationPage';
import HeaderNotification from './components/HeaderNotification';

if (!window) {
  window = {};
}
// FIXME
const crowi = new Crowi({me: $('#content-main').data('current-username')}, window);
window.crowi = crowi;
crowi.fetchUsers();

const crowiRenderer = new CrowiRenderer();
window.crowiRenderer = crowiRenderer;

const componentMappings = {
  'search-top': <HeaderSearchBox />,
  'search-page': <SearchPage />,
  'page-list-search': <PageListSearch />,
  'notification-page': <NotificationPage />,
  //'page-comment': <PageComment />,
};

Object.keys(componentMappings).forEach((key) => {
  const elem = document.getElementById(key);
  if (elem) {
    ReactDOM.render(componentMappings[key], elem);
  }
});

// Insert Notification indicator to navbar
let temp = document.createElement('div');
ReactDOM.render(<HeaderNotification />, temp);

let target = document.querySelector('#login-user');
let parent = target.parentNode;
parent.insertBefore(temp.querySelector('#notif-opener-li'), target.nextSibling);
