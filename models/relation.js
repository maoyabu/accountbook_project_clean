const mongoose = require('mongoose');

const relationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  relationUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  relationship: {
    type: String,
    enum: ['親・先祖', '子・孫', '配偶者', '親戚・兄弟', '師', '友人', '地域社会・隣人', '職場・仕事関係', 'その他'],
    default: 'その他'
  },
  relationNote: [{
    type: String
  }],
  noteHistory: [{
    content: String,
    updatedAt: { type: Date, default: Date.now }
  }],
  isActive: {
    type: Boolean,
    default: false // 承認されてはじめて true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected','blocked'],
    default: 'pending'
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  approvedAt: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

const Relation = mongoose.model('Relation', relationSchema);
module.exports = Relation;