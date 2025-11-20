const mongoose = require('mongoose');

const sharedAccessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sharedTypes: [String], // 例: ['diary', 'history']
  grantedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SharedAccess', sharedAccessSchema);