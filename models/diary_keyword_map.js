const mongoose = require('mongoose');

const diaryKeywordMapSchema = new mongoose.Schema({
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
  year: {
    type: Number,
    required: true
  },
  positions: [
    {
      name: String,
      x: Number,
      y: Number,
      count: Number
    }
  ],
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  }
});

diaryKeywordMapSchema.index({ user: 1, group: 1, year: 1 }, { unique: true });

diaryKeywordMapSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const DiaryKeywordMap = mongoose.model('diary_keyword_map', diaryKeywordMapSchema);
module.exports = DiaryKeywordMap;
