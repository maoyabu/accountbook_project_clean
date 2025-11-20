const mongoose = require('mongoose');

const plannerSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    url:{
        type: String
    },
    message:{
        type: String
    },
    adopt: {
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
plannerSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Planner = mongoose.model('Planner',plannerSchema);
module.exports = Planner;