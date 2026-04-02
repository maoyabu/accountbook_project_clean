//モデルを外部ファイルで定義して他からも読み込めるようにする
const mongoose = require('mongoose');

const regularEntrySchema = new mongoose.Schema({
    day: {
        type: Number
    },
    month: {
        type: String
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
    amount: {
        type: Number,
        required: true
    },
    payment_type: {
        type: String,
        required: true
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
    isDisabled: {
        type: Boolean,
        default: false,
        index: true
    },
    disabledAt: {
        type: Date
    },
    disabledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    entry_date: {
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    }
});

regularEntrySchema.index({ group: 1, user: 1, isDisabled: 1 });

// 🔹 更新時に update_date を自動設定する
regularEntrySchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const RegularEntry = mongoose.model('RegularEntry',regularEntrySchema);
module.exports = RegularEntry;
