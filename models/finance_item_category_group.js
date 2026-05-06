const mongoose = require('mongoose');

const categoryGroupSchema = new mongoose.Schema({
  display_order: {
    type: Number,
    required: true,
    default: 9999
  },
  year: {
    type: String,
    required: true
  },
  target_type: {
    type: String,
    required: true,
    enum: ['収入項目', '支出項目', '控除項目', '貯蓄項目']
  },
  name: {
    type: String,
    required: true
  },
  item_names: [{
    type: String
  }],
  show_in_monthly_calendar: {
    type: Boolean,
    default: false
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
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

categoryGroupSchema.index({ group: 1, year: 1, target_type: 1, display_order: 1 });

categoryGroupSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

module.exports = mongoose.model('FinanceItemCategoryGroup', categoryGroupSchema);
