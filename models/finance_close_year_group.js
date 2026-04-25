const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeCloseYearGroupSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  year: { type: Number, required: true, index: true },
  closed: { type: Boolean, default: false },
  closedAt: { type: Date },
  notifiedAt: { type: Date }
});

financeCloseYearGroupSchema.index({ group: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('FinanceCloseYearGroup', financeCloseYearGroupSchema);
