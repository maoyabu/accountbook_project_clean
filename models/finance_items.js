const mongoose = require('mongoose');

const itemsSchema = new mongoose.Schema({
    display_order: {
        type: Number,
        required: true
    },
    la_cf: {
        type: String,
        required: true
    },
    item: {
        type: String,
        required: true
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
itemsSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Items = mongoose.model('Items',itemsSchema);
module.exports = Items;