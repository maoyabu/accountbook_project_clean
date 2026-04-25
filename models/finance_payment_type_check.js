const mongoose = require('mongoose');
const { Schema } = mongoose;

const financePaymentTypeCheckSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
  ym: { type: String, required: true, index: true }, // YYYY-MM
  paymentType: { type: String, required: true, trim: true, index: true },
  checkedFinanceIds: {
    type: [{ type: Schema.Types.ObjectId, ref: 'Finance' }],
    default: []
  }
}, { timestamps: true });

financePaymentTypeCheckSchema.index(
  { user: 1, group: 1, ym: 1, paymentType: 1 },
  { unique: true }
);

module.exports = mongoose.model('FinancePaymentTypeCheck', financePaymentTypeCheckSchema);
