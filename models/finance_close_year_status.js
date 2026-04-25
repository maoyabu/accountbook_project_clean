const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeCloseYearStatusSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  year: { type: Number, required: true, index: true },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date }
});

financeCloseYearStatusSchema.index({ user: 1, group: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('FinanceCloseYearStatus', financeCloseYearStatusSchema);
