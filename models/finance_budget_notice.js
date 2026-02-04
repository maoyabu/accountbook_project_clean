const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeBudgetNoticeSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  month: { type: String, required: true, index: true }, // YYYY-MM
  targetType: { type: String, enum: ['total', 'item'], required: true },
  targetKey: { type: String, required: true }, // 'TOTAL' or expense_item
  threshold: { type: Number, required: true },
  sentAt: { type: Date, default: Date.now }
});

financeBudgetNoticeSchema.index(
  { user: 1, group: 1, month: 1, targetType: 1, targetKey: 1, threshold: 1 },
  { unique: true }
);

module.exports = mongoose.model('FinanceBudgetNotice', financeBudgetNoticeSchema);
