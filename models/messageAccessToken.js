const mongoose = require('mongoose');

const messageAccessTokenSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  expires_at: {
    type: Date,
    required: true
  },
  used_at: {
    type: Date
  },
  entry_date: {
    type: Date,
    default: Date.now
  }
});

const MessageAccessToken = mongoose.model('MessageAccessToken', messageAccessTokenSchema);
module.exports = MessageAccessToken;
