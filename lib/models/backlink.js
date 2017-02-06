module.exports = function(crowi) {
  const debug = require('debug')('crowi:models:backlink');
  const mongoose = require('mongoose');
  const ObjectId = mongoose.Schema.Types.ObjectId;
  const linkDetector = require('../util/linkDetector')(crowi);

  var backlinkSchema;

  backlinkSchema = new mongoose.Schema({
    page:         {type: ObjectId, ref: 'Page', index: true },
    fromPage:     {type: ObjectId, ref: 'Page'},
    fromRevision: {type: ObjectId, ref: 'Revision'},
    updatedAt: { type: Date, default: Date.now, index: true }
  });

  backlinkSchema.statics.findByPageId = function(pageId, limit, offset) {
    var Backlink = this;
    limit  = limit  || 10;
    offset = offset || 0;

    limit  = parseInt(limit, 10);
    offset = parseInt(offset, 10);

    return new Promise((resolve, reject) => {
      var conditions = {
        page: pageId,
      };
      var projection = {
        fromPage: 1,
        fromRevision: 1,
        updatedAt: 1,
      };
      var options = {
        limit: limit,
        skip: offset,
        sort: {updatedAt: -1},
      };

      Backlink
        .find(conditions, projection, options)
        .populate('fromPage')
        .populate('fromRevision')
        .exec((err, backlinks) => {
          if (err) {
            return reject(err);
          }

          // populate author
          var options = {
            path: 'fromRevision.author',
            model: 'User',
            select: {
              username: 1,
              name: 1,
              image: 1,
            }
          };
          Backlink.populate(backlinks, options, (err, backlinks) => {
            if (err) {
              return reject(err);
            }

            return resolve(backlinks);
          });
        });
    });
  };

  backlinkSchema.statics.removeBySavedPage = function(savedPage) {
    var Backlink = this;

    return new Promise((resolve, reject) => {
      var conditions = {
        fromPage: savedPage._id,
      };

      Backlink.remove(conditions, (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
    });
  };

  backlinkSchema.statics.createByParameters = function(parameters) {
    var BackLink = this;

    return new Promise((resolve, reject) => {
      var data = {
        page: parameters.page,
        fromPage: parameters.fromPage,
        fromRevision: parameters.fromRevision,
        updatedAt: Date.now(),
      };
      BackLink.create(data, (err, savedBacklink) => {
        if (err) {
          return reject(err);
        }

        return resolve(savedBacklink);
      });
    });
  };

  backlinkSchema.statics.createBySavedPage = function(savedPage) {
    var BackLink = this;
    var Page = crowi.model('Page');

    return new Promise((resolve, reject) => {
      if (!(savedPage.revision && savedPage.revision.body)) {
        reject('no revision/body in savedPage');
      }

      var body = savedPage.revision.body;
      var links = linkDetector.search(body);

      var promises = [];
      links.paths.forEach((path) => {
        promises.push(Page.isExistByPath(path));
      });
      links.objectIds.forEach((id) => {
        promises.push(Page.isExistById(id));
      });

      BackLink
        .removeBySavedPage(savedPage)
        .then((removeResult) => {
          return Promise.all(promises);
        })
        .then((ids) => {
          var checker = {};
          var createPromises = [];
          ids.forEach(function(id) {
            // Skip same page
            if (id.toString() in checker) {
              return;
            }
            // Skip own page link
            if (id.toString() === savedPage._id.toString()) {
              return;
            }

            var parameters = {
              page: id,
              fromPage: savedPage._id,
              fromRevision: savedPage.revision._id,
            };
            createPromises.push(BackLink.createByParameters(parameters));
            checker[id.toString()] = true;
          });

          return Promise.all(createPromises);
        })
        .then((backlinks) => {
          debug('backlinks saved');
          resolve(backlinks);
        })
        .catch((err) => {
          reject(err);
        });
    });
  };

  return mongoose.model('BackLink', backlinkSchema);
}
