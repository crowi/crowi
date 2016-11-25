var chai = require('chai')
  , expect = chai.expect
  , sinon = require('sinon')
  , sinonChai = require('sinon-chai')
  , Promise = require('bluebird')
  , utils = require('../utils.js')
  ;
chai.use(sinonChai);

describe('Notification', function () {
  var Comment = utils.models.Comment;
  var Notification = utils.models.Notification;
  var Page = utils.models.Page;
  var User = utils.models.User;
  var conn   = utils.mongoose.connection;

  var data = {};

  before(function(done) {
    Promise.resolve().then(function() {
      var userFixtures = [
        {name: 'creator',   username: 'creator',   email: 'creator@example.com'},
        {name: 'commenter', username: 'commenter', email: 'commenter@example.com'},
      ];

      return testDBUtil.generateFixture(conn, 'User', userFixtures).then(function(users) {
        return users;
      });
    }).then(function(users) {
      var pageFixtures = [
        {
          path: '/page1',
          grant: Page.GRANT_PUBLIC,
          grantedUsers: [users[0]],
          creator: users[0]
        }
      ];
      return testDBUtil.generateFixture(conn, 'Page', pageFixtures).then(function(pages) {
        return {
          users: users,
          pages: pages
        };
      });
    }).then(function(data) {
      var commentFixtures = [
        {
          page: data.pages[0],
          creator: data.users[0],
          comment: 'comment',
          commentPosition: -1
        }
      ];
      return testDBUtil.generateFixture(conn, 'Comment', commentFixtures).then(function(comments) {
        return {
          users: data.users,
          pages: data.pages,
          comments: comments
        };
      });
    }).then(function(data) {
      this.data = data;
      done();
    });
  });

  // describe('CreateByPageAndComment', function() {
  //   context('Notification', function() {
  //     it('should created', function(done) {
  //       Promise.resolve().then(function() {
  //         return Page.findPageByPath('/page1');
  //       }).then(function(page) {
  //         return Promise.resolve().then(function() {
  //           return Comment.getCommentsByPageId(page._id);
  //         }).then(function(comments) {
  //           return {
  //             page: page,
  //             comments: comments
  //           };
  //         });
  //       }).then(function(data) {
  //         return Promise.resolve().then(function() {
  //           return Notification.createByPageAndComment(data.page, data.comments[0]);
  //         }).then(function(notification) {
  //           return {
  //             notification: notification,
  //             page: data.page,
  //             comments: data.comments
  //           };
  //         });
  //       }).then(function(data) {
  //         var notification = data.notification;
  //         var page = data.page;
  //         var comments = data.comments;

  //         expect(notification).to.instanceof(Notification);
  //         expect(notification.to).to.equal(page.creator);
  //         expect(notification.from).to.equal(comments[0].creator);
  //         expect(notification.type).to.equal('comment');

  //         done();
  //       }).catch(function(error) {
  //         done(error);
  //       });
  //     });
  //   });
  // });

  // describe('FindByUser', function() {
  //   context('find', function() {
  //     it('should read', function(done) {
  //       // fixture

  //       // findByUser

  //     });
  //   });
  // });

});
