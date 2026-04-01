const mongoose = require('mongoose');

const personalBudgetSchema = new mongoose.Schema({
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

personalBudgetSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const PersonalBudget = mongoose.model('PersonalBudget', personalBudgetSchema);
module.exports = PersonalBudget;
