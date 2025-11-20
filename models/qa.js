const mongoose = require('mongoose');

const qaSchema = new mongoose.Schema({
    qa_category: {
        type: String,
        required: true
    },
    qa_question: {
        type: String,
        required: true
    },
    qa_answer: {
        type: String,
        required: true
    },
    url:{
        type: String
    },
    faq_flag: {
        type: Boolean,
        default: false
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
qaSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Qa = mongoose.model('Qa',qaSchema);
module.exports = Qa;