/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// identity function for calling harmony imports with the correct context
/******/ 	__webpack_require__.i = function(value) { return value; };
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, {
/******/ 				configurable: false,
/******/ 				enumerable: true,
/******/ 				get: getter
/******/ 			});
/******/ 		}
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = 1550);
/******/ })
/************************************************************************/
/******/ ({

/***/ 1550:
/***/ (function(module, exports, __webpack_require__) {

"use strict";


$(function () {
  var UpdatePost = {};

  $('#slackNotificationForm').on('submit', function (e) {
    $.post('/_api/admin/notification.add', $(this).serialize(), function (res) {
      if (res.ok) {
        // TODO Fix
        location.reload();
      }
    });

    return false;
  });

  $('form.admin-remove-updatepost').on('submit', function (e) {
    $.post('/_api/admin/notification.remove', $(this).serialize(), function (res) {
      if (res.ok) {
        // TODO Fix
        location.reload();
      }
    });
    return false;
  });

  $('#createdUserModal').modal('show');

  $('#admin-password-reset-modal').on('show.bs.modal', function (button) {
    var data = $(button.relatedTarget);
    var userId = data.data('user-id');
    var email = data.data('user-email');

    $('#admin-password-reset-user').text(email);
    $('#admin-users-reset-password input[name=user_id]').val(userId);
  });

  $('form#admin-users-reset-password').on('submit', function (e) {
    $.post('/_api/admin/users.resetPassword', $(this).serialize(), function (res) {
      if (res.ok) {
        // TODO Fix
        //location.reload();
        $('#admin-password-reset-modal').modal('hide');
        $('#admin-password-reset-modal-done').modal('show');

        $("#admin-password-reset-done-user").text(res.user.email);
        $("#admin-password-reset-done-password").text(res.newPassword);
        return;
      }

      // fixme
      alert('Failed to reset password');
    });

    return false;
  });
});

/***/ })

/******/ });