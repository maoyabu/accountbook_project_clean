const mongoose = require('mongoose');

const historyCategorySchema = new mongoose.Schema({
    name: { type: String, required: true }, // 例：住所、好きな曲など
    fields: [{
        name: { type: String, required: true },
        type: { type: String, required: true }
    }],
    color: {
        type: String,
        default: '#000000'
    },
    photos: [{ type: String }],
    // 共通フィールド（デフォルト項目）
    isResume: { type: Boolean, default: false }, // 履歴書に含めるかどうか
    isActive: { type: Boolean, default: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    entry_date: { type: Date, default: Date.now },
    update_date: { type: Date },
    share: { type: Boolean, default: false }
});

historyCategorySchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: new Date() });
  next();
});

const HistoryCategory = mongoose.model('HistoryCategory',historyCategorySchema);
module.exports = HistoryCategory;