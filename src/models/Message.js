const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      default: () => new mongoose.Types.ObjectId(),
      unique: true,
    },
    sender: {
      type: String,
      required: true,
      index: true,
    },
    encryptedContent: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    recipients: [
      {
        type: String,
        index: true,
      },
    ],
    recipientKeys: {
      type: Map,
      of: String,
      default: {},
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    readBy: [
      {
        username: {
          type: String,
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    isUnread: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      expires: 0,
      default: function () {
        const date = new Date();
        date.setDate(date.getDate() + 90);
        return date;
      },
    },
  },
  {
    timestamps: false,
    versionKey: false,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

messageSchema.index({ recipients: 1, timestamp: -1 });
messageSchema.index({ sender: 1, timestamp: -1 });
messageSchema.index({ "readBy.username": 1, timestamp: -1 });

messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

messageSchema.index({ isUnread: 1, timestamp: -1 });

messageSchema.statics.getMessagesForUser = async function (
  username,
  page = 1,
  limit = 20
) {
  const skip = (page - 1) * limit;

  return this.find({ recipients: username })
    .select("_id sender encryptedContent iv recipientKeys timestamp isUnread")
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

messageSchema.statics.markAsRead = async function (messageId, username) {
  return this.updateOne(
    {
      _id: messageId,
      recipients: username,
      "readBy.username": { $ne: username },
    },
    {
      $addToSet: {
        readBy: {
          username,
          readAt: new Date(),
        },
      },
      $set: { isUnread: false },
    }
  );
};

messageSchema.pre("save", function (next) {
  const approximateSize =
    (this.encryptedContent ? this.encryptedContent.length : 0) +
    (this.iv ? this.iv.length : 0) +
    JSON.stringify(this.recipientKeys).length +
    JSON.stringify(this.recipients).length;

  if (approximateSize > 15 * 1024 * 1024) {
    return next(new Error("Message size exceeds maximum allowed size"));
  }

  next();
});

const Message = mongoose.model("Message", messageSchema);

Message.createIndexes().catch((err) => {
  console.error("Error creating message indexes:", err);
});

module.exports = Message;
