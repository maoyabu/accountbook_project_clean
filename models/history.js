const mongoose = require('mongoose');

const historySchema = new mongoose.Schema({
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'HistoryCategory', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    data: mongoose.Schema.Types.Mixed, // { 郵便番号: '244-0817', 都道府県: '神奈川県', ... }
    from_date: Date,
    end_date: Date,
    url: String,
    content: String,
    photos: [
      {
        url: String,
        source: { type: String, enum: ['local', 'google', 'cloudinary'], default: 'local' }
      }
    ],
    isResume: { type: Boolean, default: false },
    isActive: { type: Boolean, default: false },
    share: { type: Boolean, default: true },
    entry_date: { type: Date, default: Date.now },
    update_date: { type: Date }
});

historySchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: new Date() });
  next();
});

const History = mongoose.model('History',historySchema);
module.exports = History;