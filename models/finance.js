//モデルを外部ファイルで定義して他からも読み込めるようにする
const mongoose = require('mongoose');

const financeSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    month: {
        type: Number,
        required: true
    },
    day: {
        type: Number,
        required: true
    },
    cf: {
        type: String,
        required: true
    },
    income_item: {
        type: String
    },
    expense_item: {
        type: String
    },
    dedu_item: {
        type: String
    },
    saving_item: {
        type: String
    },
    content: {
        type: String
    },
    sub_tag: {
        type: String
    },
    amount: {
        type: Number,
        required: true
    },
    payment_type: {
        type: String,
        required: true
    },
    corrected: {
        storeName: { type: String },
        amount: { type: String },
        date: { type: String }
    },
    memo: {
        type: String
    },
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
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    },
    tags: [{
        name: { type: String },
        category: { type: String }, // オプション強化ポイント：カテゴリ（例：食品、日用品など）
        price: { type: Number }     // オプション強化ポイント：価格情報（任意）
    }]
});

// 🔹 更新時に update_date を自動設定する
financeSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Finance = mongoose.model('Finance',financeSchema);
module.exports = Finance;
