const mongoose = require('mongoose');

const categoryMappingSchema = new mongoose.Schema({
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
    unique: true
  },
  mapping: {
    type: Map,
    of: String,
    default: {}
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('CategoryMapping', categoryMappingSchema);