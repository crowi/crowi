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
      page_id: { type: ObjectId, ref: "Page", required: true, index: true },
      status: { type: String, default: STATUS_ACTIVE, index: true },
      creator: { type: ObjectId, ref: "User", required: true, index: true },
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
    this.populated("creator");
    const creatorId = this.creator._id.toString();
    const userId = userData._id.toString();

    return creatorId === userId;
  };

  shareSchema.statics.populateShareData = async function(shareData) {
    const self = this;
    const User = crowi.model("User");

    return self.populate(shareData, [
      { path: "creator", model: "User", select: User.USER_PUBLIC_FIELDS }
    ]);
  };

  shareSchema.statics.findShareById = async function(id) {
    const self = this;

    return await self.findOne({ _id: id }, (err, shareData) => {
      if (err) {
        throw err;
      }

      if (shareData === null) {
        const shareNotFoundError = new Error("Share Not Found");
        shareNotFoundError.name = "Crowi:Share:NotFound";
        return shareNotFoundError;
      }

      return self.populateShareData(shareData);
    });
  };

  shareSchema.statics.findShareByPageId = async function(page_id) {
    const self = this;

    return await self.findOne({ page_id: page_id }, (err, shareData) => {
      if (err) {
        throw err;
      }

      if (shareData === null) {
        const shareNotFoundError = new Error("Share Not Found");
        shareNotFoundError.name = "Crowi:Share:NotFound";
        return shareNotFoundError;
      }

      return self.populateShareData(shareData);
    });
  };

  shareSchema.statics.findActiveShareByPageId = async function(page_id) {
    const self = this;

    return await self.findOne({ page_id: page_id, status: STATUS_ACTIVE }, (err, shareData) => {
      if (err) {
        throw err;
      }

      if (shareData === null) {
        const shareNotFoundError = new Error("Share Not Found");
        shareNotFoundError.name = "Crowi:Share:NotFound";
        return shareNotFoundError;
      }

      return self.populateShareData(shareData);
    });
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

  shareSchema.statics.list = async function(page_id) {
    const Share = this;

    const shareData = await Share.findActiveShareByPageId(page_id);
    if (shareData) {
      throw new Error("Cannot create new share.");
    }

    const newShare = new Share({
      id,
      page_id,
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

  shareSchema.statics.create = async function(id, page_id, user, options) {
    const Share = this;

    const shareData = await Share.findActiveShareByPageId(page_id);
    if (shareData) {
      throw new Error("Cannot create new share.");
    }

    const newShare = new Share({
      id,
      page_id,
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

  return mongoose.model("Share", shareSchema);
};
