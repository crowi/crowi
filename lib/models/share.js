module.exports = function(crowi) {
  var debug = require("debug")("crowi:models:page"),
    mongoose = require("mongoose"),
    ObjectId = mongoose.Schema.Types.ObjectId,
    STATUS_ACTIVE = "active",
    STATUS_INACTIVE = "inactive",
    shareSchema;

  shareSchema = new mongoose.Schema(
    {
      id: { type: String, required: true, index: true, unique: true },
      page: { type: ObjectId, ref: "Page", required: true, index: true },
      status: { type: String, default: STATUS_ACTIVE, index: true },
      creator: { type: ObjectId, ref: "User", required: true, index: true },
      secretKeyword: String,
      extended: {
        type: String,
        default: "{}",
        get: data => {
          try {
            return JSON.parse(data);
          } catch (e) {
            return data;
          }
        },
        set: data => {
          return JSON.stringify(data);
        }
      },
      createdAt: { type: Date, default: Date.now },
      updatedAt: Date
    },
    {
      toJSON: { getters: true },
      toObject: { getters: true }
    }
  );

  shareSchema.methods.isActive = function() {
    return this.status === STATUS_ACTIVE;
  };

  shareSchema.methods.isInactive = function() {
    return this.status === STATUS_INACTIVE;
  };

  shareSchema.methods.isCreator = function(userData) {
    this.populate("creator");
    const creatorId = this.creator._id.toString();
    const userId = userData._id.toString();

    return creatorId === userId;
  };

  shareSchema.statics.isExists = async function(query) {
    const self = this;
    const count = await self.count(query);
    return count > 0;
  };

  shareSchema.statics.findShare = async function(query) {
    const self = this;
    const User = crowi.model("User");
    const Page = crowi.model("Page");

    const shareData = await self
      .findOne(query)
      .populate({ path: "page", model: "Page" })
      .populate({
        path: "creator",
        model: "User",
        select: User.USER_PUBLIC_FIELDS
      })
      .exec((err, shareData) => {
        if (err) {
          throw err;
        }
        return shareData;
      });

    if (shareData === null) {
      const shareNotFoundError = new Error("Share Not Found");
      shareNotFoundError.name = "Crowi:Share:NotFound";
      throw shareNotFoundError;
    }

    shareData.page = await Page.populatePageData(shareData.page);
    return shareData;
  };

  shareSchema.statics.findShareById = async function(id, status) {
    const self = this;
    const query = Object.assign({ id }, status !== undefined ? { status } : {});
    return await self.findShare(query);
  };

  shareSchema.statics.findShareByPageId = async function(page_id, status) {
    const self = this;
    const query = Object.assign(
      { page: page_id },
      status !== undefined ? { status } : {}
    );
    return await self.findShare(query);
  };

  shareSchema.statics.updateProperty = async function(share, updateData) {
    const self = this;
    return await self.update(
      { _id: share._id },
      { $set: updateData },
      (err, data) => {
        if (err) {
          throw err;
        }

        return data;
      }
    );
  };

  shareSchema.statics.create = async function(id, page_id, user, options) {
    const Share = this;

    const isExists = await Share.isExists({
      page: page_id,
      status: STATUS_ACTIVE
    });
    if (isExists) {
      throw new Error("Cannot create new share.");
    }

    const newShare = new Share({
      id,
      page: page_id,
      creator: user,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: STATUS_ACTIVE
    });
    newShare.save(err => {
      if (err) {
        throw err;
      }
    });
    return newShare;
  };

  shareSchema.statics.delete = async function(shareData) {
    var self = this;

    const data = await self.updateProperty(shareData, {
      status: STATUS_INACTIVE
    });
    return data;
  };

  shareSchema.statics.STATUS_ACTIVE = STATUS_ACTIVE;
  shareSchema.statics.STATUS_INACTIVE = STATUS_INACTIVE;

  return mongoose.model("Share", shareSchema);
};
