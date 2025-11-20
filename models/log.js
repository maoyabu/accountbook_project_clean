const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const logSchema = new Schema({
  type: {
    type: String,
    enum: ['login', 'page', 'action'],
    required: true
  },
  username: String,
  userId: { type: Schema.Types.ObjectId, ref: 'FinanceUser' },
  ip: String,
  timestamp: { type: Date, default: Date.now },

  // Login-specific
  success: Boolean,

  // Page access-specific
  page: String,

  // Action-specific
  action: String,
  target: String
});

module.exports = mongoose.model('Log', logSchema);