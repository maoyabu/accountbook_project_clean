const mongoose = require('mongoose');

const ocrLogSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true
  },
  extracted: {
    storeName: { type: String, required: true },
    amount: { type: String, required: true },
    date: { type: String, required: true }
  },
  corrected: {
    storeName: { type: String },
    amount: { type: String },
    date: { type: String },
    tags: [{
      name: { type: String },
      category: { type: String }, // 最終的にマッピングされたカテゴリ
      gptCategory: { type: String }, // GPTが返した元のカテゴリ
      price: { type: Number }
    }]
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('OCRLog', ocrLogSchema);
