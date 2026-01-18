const mongoose = require('mongoose');

const budgetSchema = new mongoose.Schema({
    display_order: {
        type: Number,
        required: true
    },
    year: {
        type: String,
        required: true
    },
    expense_item: {
        type: String
    },
    budget: {
        type: Number,
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
    }
});

// 🔹 更新時に update_date を自動設定する
budgetSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Budget = mongoose.model('Budget',budgetSchema);
module.exports = Budget;