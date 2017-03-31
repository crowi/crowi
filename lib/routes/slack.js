module.exports = function(crowi, app) {
  'use strict';

  var slackHelper = require('../util/slack')(crowi)
  , Page = crowi.model('Page')
  , User = crowi.model('User')
  , actions = {};

  var api = actions.api = {};

  function fetchPage(link) {
  }

  api.handleEvent = function(req, res) {
    if (req.body.type != null && req.body.type == 'url_verification') {
      verifyChallenge(req, res);
      return;
    }

    let event = req.body.event;
    switch (event.type) {
      case 'link_shared':
      unfurl(req, res);
      break;
      default:
      break;
    }
  }

  function verifyChallenge(req, res) {
    res.send(req.body.challenge);
  }

  function unfurl(req, res) {
    const https = require('https');
    const HOST = 'slack.com'
    const PATH = '/api/chat.unfurl';

    const link = req.body.event.links[0];
    const channel = req.body.event.channel;
    const url = require('url').parse(link.url, true);

    var pagePath = url.path || null;
    var pageId = url.query.page_id || null; // TODO: handling
    var revisionId = url.query.revision_id || null;

    User.findAllUsers()
    .then (function(users) {
      return Page.findPage(pagePath, users[0], revisionId);
    })
    .then(function(pageData) {
      let unfurls = { };
      unfurls[link.url] = {
        "title": pageData.path,
        "text": slackHelper.prepareAttachmentTextForCreate(pageData)
      };

      let config = crowi.getConfig();
      let token = config.notification['slack:token'];
      let postData = {
        "token": token,
        "channel": channel,
        "ts": req.body.event.message_ts,
        "unfurls": encodeURIComponent(JSON.stringify(unfurls))
      };

      let postDataStr = JSON.stringify(postData);

      let options = {
        host: HOST,
        port: 443,
        path: PATH + "?token=" + postData['token'] + '&channel=' + postData["channel"] + "&ts=" + postData["ts"] + "&unfurls=" + postData["unfurls"],
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8'
        }
      };

      let slackReq = https.request(options, (slackRes) => {
        slackRes.setEncoding('utf8');
      });
      slackReq.on('error', (e) => {
        console.error('failed to send a request to Slack: ' + e.message);
      });
      slackReq.end();
      res.send(200);
    })
    .catch(function(err) {
      console.error('failed in fetching page: ' + err);
      res.send(404);
    });
  }

  return actions;
};
