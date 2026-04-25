const mongoose = require('mongoose');

const messageStatusSchema = new mongoose.Schema({
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
  last_alive_at: {
    type: Date
  },
  warning_started_at: {
    type: Date
  },
  warning_days_sent: {
    type: Number,
    default: 0
  },
  pre_notice_sent_at: {
    type: Date
  },
  final_sent_at: {
    type: Date
  },
  last_alive_source: {
    type: String,
    enum: ['service', 'email']
  },
  last_alive_notice_sent_at: {
    type: Date
  }
});

const MessageStatus = mongoose.model('MessageStatus', messageStatusSchema);
module.exports = MessageStatus;
