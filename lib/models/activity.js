module.exports = function(crowi) {
  'use strict';

  const debug    = require('debug')('crowi:models:activity');
  const mongoose = require('mongoose');
  const ObjectId = mongoose.Schema.Types.ObjectId;
  const ActivityDefine = require('../util/activityDefine')();

  // TODO: add revision id
  const activitySchema = new mongoose.Schema({
    user: {
      type: ObjectId,
      ref: 'User',
      index: true,
      require: true,
    },
    targetModel: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportModelNames(),
    },
    target: {
      type: ObjectId,
      refPath: 'targetModel',
      require: true,
    },
    action: {
      type: String,
      require: true,
      enum: ActivityDefine.getSupportActionNames(),
    },
    createdAt: {
      type: Date,
      default: Date.now,
    }
  });
  activitySchema.index({user: 1, target: 1, action: 1, createdAt: 1}, {unique: true});

  /**
   * @param {Object} parameters
   * @return {Promise}
   */
  activitySchema.statics.createByParameters = function(parameters) {
    const Activity = this;

    return new Promise(function(resolve, reject) {
      try {
        resolve(Activity.create(parameters));
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
   * @param {Object} parameters
   */
  activitySchema.statics.removeByParameters = function(parameters) {
    const Activity = this;

    return new Promise(function(resolve, reject) {
      try {
        resolve(Activity.remove(parameters));
      } catch (e) {
        reject(e);
      }
    });
  };

  /**
   * @param {Comment} comment
   * @return {Promise}
   */
  activitySchema.statics.createByPageComment = function(comment) {
    let parameters = {
      user: comment.get('creator'),
      targetModel: ActivityDefine.MODEL_PAGE,
      target: comment.get('page'),
      action: ActivityDefine.ACTION_COMMENT,
    };

    return this.createByParameters(parameters);
  };

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.createByPageLike = function(page, user) {
    let parameters = {
      user: user._id,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page,
      action: ActivityDefine.ACTION_LIKE,
    };

    return this.createByParameters(parameters);
  };

  /**
   * @param {Page} page
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.removeByPageUnlike = function(page, user) {
    let parameters = {
      user: user,
      targetModel: ActivityDefine.MODEL_PAGE,
      target: page,
    };

    return this.removeByParameters(parameters);
  };

  /**
   * @param {User} user
   * @return {Promise}
   */
  activitySchema.statics.findByUser = function(user) {
    let Activity = this;

    return new Promise(function(resolve, reject) {
      Activity
        .find({user: user})
        .sort({createdAt: -1})
        .exec(function(err, notifications) {
          if (err) {
            return reject(err);
          }

          return resolve(notifications);
        });
    });
  };

  activitySchema.methods.getSameActivityUniqueUsers = function() {
    const self = this;
    const limit = 1000;

    return new Promise(function(resolve, reject) {
      const query = {
        target: self.target,
        action: self.action,
      };

      self
        .model('Activity')
        .find(query)
        .sort({
          createdAt: -1,
        })
        .limit(limit)
        .exec(function(err, activities) {
          if (err) {
            reject(err);
          }

          let uniqueChecker = {};
          let sameActionUsers = [];
          activities.forEach(function(activity) {
            const user_id = activity.user.toString();
            if (uniqueChecker[user_id] !== 1) {
              sameActionUsers.push(activity.user);
              uniqueChecker[user_id] = 1;
            }
          });

          debug(sameActionUsers);
          resolve(sameActionUsers);
        })
      ;
    });
  };

  activitySchema.methods.getNotificationTargetUsers = function() {
    let self = this;

    return new Promise(function(resolve, reject) {
      self.model(self.targetModel)
        .findById(self.target, function(err, model) {
          if (err) {
            reject(err);
          }

          resolve(model.getNotificationTargetUsers());
        })
      ;
    });
  };

  /**
   * saved hook
   */
  activitySchema.post('save', function(savedActivity) {
    const Notification = crowi.model('Notification');

    Promise
      .all([
        savedActivity.getNotificationTargetUsers(),
        savedActivity.getSameActivityUniqueUsers(),
      ])
      .then(function(results) {
        const notificationTargetUsers = results[0];
        const sameActivityUsers       = results[1];

        let notificationPromises = [];
        notificationTargetUsers.forEach(function(user) {

          if (user.toString() === savedActivity.user.toString()) {
            debug(`user:${user} is activitiy owner. Do not create notification.`);
            return;
          }

          let filteredUsers = sameActivityUsers.filter(function(sameActionUser) {
            return user.toString() !== sameActionUser.toString();
          });

          notificationPromises.push(
            Notification.upsertByActivity(user, filteredUsers, savedActivity)
          );
        });

        return Promise.all(notificationPromises);
      })
      .then(function(notifications) {
        debug('created notifications', notifications);
      })
      .catch(function(err) {
        debug(err);
      })
    ;
  });

  return mongoose.model('Activity', activitySchema);
}
