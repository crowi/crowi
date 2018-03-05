/**
 * Crowi context class for client
 */

import axios from 'axios'
import InterceptorManager from '../../../lib/util/interceptor-manager';

import {
  DetachCodeBlockInterceptor,
  RestoreCodeBlockInterceptor,
} from './interceptor/detach-code-blocks';

export default class Crowi {
  constructor(context, window) {
    this.context = context;
    this.config = {};
    this.csrfToken = context.csrfToken;

    this.window = window;
    this.location = window.location || {};
    this.document = window.document || {};
    this.localStorage = window.localStorage || {};
    this.pageEditor = undefined;

    this.fetchUsers = this.fetchUsers.bind(this);
    this.apiGet = this.apiGet.bind(this);
    this.apiPost = this.apiPost.bind(this);
    this.apiRequest = this.apiRequest.bind(this);

    this.interceptorManager = new InterceptorManager();
    this.interceptorManager.addInterceptors([
      new DetachCodeBlockInterceptor(this),
      new RestoreCodeBlockInterceptor(this),
    ]);

    // FIXME
    this.me = context.me;

    this.users = [];
    this.userByName = {};
    this.userById   = {};
    this.draft = {};
    this.editorOptions = {};

    this.recoverData();
  }

  /**
   * @return {Object} window.Crowi (/resource/js/crowi.js)
   */
  getCrowiForJquery() {
    return window.Crowi;
  }

  getContext() {
    return context;
  }

  setConfig(config) {
    this.config = config;
  }

  getConfig() {
    return this.config;
  }

  setPageEditor(pageEditor) {
    this.pageEditor = pageEditor;
  }

  recoverData() {
    const keys = [
      'userByName',
      'userById',
      'users',
      'draft',
      'editorOptions',
      'previewOptions',
    ];

    keys.forEach(key => {
      if (this.localStorage[key]) {
        try {
          this[key] = JSON.parse(this.localStorage[key]);
        } catch (e) {
          this.localStorage.removeItem(key);
        }
      }
    });
  }

  fetchUsers () {
    const interval = 1000*60*15; // 15min
    const currentTime = new Date();
    if (this.localStorage.lastFetched && interval > currentTime - new Date(this.localStorage.lastFetched)) {
      return ;
    }

    this.apiGet('/users.list', {})
    .then(data => {
      this.users = data.users;
      this.localStorage.users = JSON.stringify(data.users);

      let userByName = {};
      let userById = {};
      for (let i = 0; i < data.users.length; i++) {
        const user = data.users[i];
        userByName[user.username] = user;
        userById[user._id] = user;
      }
      this.userByName = userByName;
      this.localStorage.userByName = JSON.stringify(userByName);

      this.userById = userById;
      this.localStorage.userById = JSON.stringify(userById);

      this.localStorage.lastFetched = new Date();
    }).catch(err => {
      this.localStorage.removeItem('lastFetched');
      // ignore errors
    });
  }

  setCaretLine(line) {
    if (this.pageEditor != null) {
      this.pageEditor.setCaretLine(line);
    }
  }

  focusToEditor() {
    if (this.pageEditor != null) {
      this.pageEditor.focusToEditor();
    }
  }

  clearDraft(path) {
    delete this.draft[path];
    this.localStorage.setItem('draft', JSON.stringify(this.draft));
  }

  saveDraft(path, body) {
    this.draft[path] = body;
    this.localStorage.setItem('draft', JSON.stringify(this.draft));
  }

  findDraft(path) {
    if (this.draft && this.draft[path]) {
      return this.draft[path];
    }

    return null;
  }

  saveEditorOptions(options) {
    this.localStorage.setItem('editorOptions', JSON.stringify(options));
  }

  savePreviewOptions(options) {
    this.localStorage.setItem('previewOptions', JSON.stringify(options));
  }

  findUserById(userId) {
    if (this.userById && this.userById[userId]) {
      return this.userById[userId];
    }

    return null;
  }

  findUserByIds(userIds) {
    let users = [];
    for (let userId of userIds) {
      let user = this.findUserById(userId);
      if (user) {
        users.push(user);
      }
    }

    return users;
  }

  findUser(username) {
    if (this.userByName && this.userByName[username]) {
      return this.userByName[username];
    }

    return null;
  }

  apiGet(path, params) {
    return this.apiRequest('get', path, {params: params});
  }

  apiPost(path, params) {
    if (!params._csrf) {
      params._csrf = this.csrfToken;
    }

    return this.apiRequest('post', path, params);
  }

  apiRequest(method, path, params) {

    return new Promise((resolve, reject) => {
      axios[method](`/_api${path}`, params)
      .then(res => {
        if (res.data.ok) {
          resolve(res.data);
        } else {
          reject(new Error(res.data.error));
        }
      })
      .catch(res => {
        reject(res);
      });
    });
  }

}

