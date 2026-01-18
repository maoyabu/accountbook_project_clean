const mongoose = require('mongoose');

const DictEntrySchema = new mongoose.Schema({
  word: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 更新時に updatedAt を自動更新
DictEntrySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('DictEntry', DictEntrySchema);