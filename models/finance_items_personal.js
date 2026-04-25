const mongoose = require('mongoose');

const personalItemSchema = new mongoose.Schema({
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
  year: {
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
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  }
});

personalItemSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const PersonalItem = mongoose.model('PersonalItem', personalItemSchema);
module.exports = PersonalItem;
