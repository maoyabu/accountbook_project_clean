const mongoose = require('mongoose');
const { Schema } = mongoose;

const plannedMemoSchema = new Schema({
  day: { type: Number, min: 1, max: 31 },
  note: { type: String, trim: true, default: '' },
  cashTopup: { type: Number, default: 0 }
}, { _id: false });

const financeMonthlyCalendarSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  year: { type: Number, required: true, index: true },
  month: { type: Number, required: true, min: 1, max: 12, index: true },
  ym: { type: String, index: true },
  carryCash: { type: Number, default: 0 },
  plannedMemos: { type: [plannedMemoSchema], default: [] },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

financeMonthlyCalendarSchema.index({ group: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('FinanceMonthlyCalendar', financeMonthlyCalendarSchema);
