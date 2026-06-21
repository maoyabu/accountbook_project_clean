const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeDailySummaryDeliverySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  summaryDate: { type: String, required: true },
  sentAt: { type: Date, default: null }
}, { timestamps: true });

financeDailySummaryDeliverySchema.index({ user: 1, summaryDate: 1 }, { unique: true });

module.exports = mongoose.model('FinanceDailySummaryDelivery', financeDailySummaryDeliverySchema);
