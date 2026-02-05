const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeCloseGroupSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  month: { type: String, required: true, index: true }, // YYYY-MM
  closed: { type: Boolean, default: false },
  closedAt: { type: Date },
  notifiedAt: { type: Date }
});

financeCloseGroupSchema.index({ group: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('FinanceCloseGroup', financeCloseGroupSchema);
