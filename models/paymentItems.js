const mongoose = require('mongoose');

const paymentItemSchema = new mongoose.Schema({
    paymentItem: {
        type: String,
        required: true
    },
    display_order: {
        type: Number,
        required: true
    },
    isLive: {
        type: Boolean,
        default: false
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
    }
});

// 🔹 更新時に update_date を自動設定する
paymentItemSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const PaymentItem = mongoose.model('PaymentItem',paymentItemSchema);
module.exports = PaymentItem;