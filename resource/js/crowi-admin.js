$(function() {
  var UpdatePost = {};

  $('#slackNotificationForm').on('submit', function(e) {
    $.post('/_api/admin/notification.add', $(this).serialize(), function(res) {
      if (res.ok) {
        // TODO Fix
        location.reload();
      }
    });

    return false;
  });

  $('form.admin-remove-updatepost').on('submit', function(e) {
    $.post('/_api/admin/notification.remove', $(this).serialize(), function(res) {
      if (res.ok) {
        // TODO Fix
        location.reload();
      }
    });
    return false;
  });

  $('#createdUserModal').modal('show');
});

import React from 'react';
import ReactDOM from 'react-dom';

import AdminUserPage  from './components/Admin/UserPage';

if (!window) {
  window = {};
}

// FIXME
// window.crowi is set by app.js
if (window.crowi) {
  const adminComponentMappings = {
    'admin-user-page': <AdminUserPage />,
  };

  Object.keys(adminComponentMappings).forEach((key) => {
    const elem = document.getElementById(key);
    if (elem) {
      ReactDOM.render(adminComponentMappings[key], elem);
    }
  });
}

