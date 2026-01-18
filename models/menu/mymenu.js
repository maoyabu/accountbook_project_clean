const mongoose = require('mongoose');

const mymenuSchema = new mongoose.Schema({
    menu: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Menu',
        required: true
    },
    favorite: {
        type: String
    },
    skill: {
        type: String
    },
    frequency: {
        type: String
    },
    myurl: {
        type: String
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
mymenuSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Mymenu = mongoose.model('Mymenu',mymenuSchema);
module.exports = Mymenu;