const mongoose = require('mongoose');

const seasoningSchema = new mongoose.Schema({
    seasoning: {
        type: String,
        required: true
    },
    classification: {
        type: String
    },
    energy: {
        type: String
    },
    water: {
        type: String
    },
    protein: {
        type: String
    },
    lipid: {
        type: String
    },
    carbohydrate: {
        type: String
    },
    unit: {
        type: [String]  // 例: ['g', 'ml']
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定する
seasoningSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Seasoning = mongoose.model('Seasoning',seasoningSchema);
module.exports = Seasoning;