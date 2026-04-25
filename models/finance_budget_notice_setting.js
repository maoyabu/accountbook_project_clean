const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeBudgetNoticeSettingSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  noticeHour: { type: Number, default: 8 },
  lastFiscalAlertYear: { type: Number, default: null }
});

financeBudgetNoticeSettingSchema.index({ group: 1 }, { unique: true });

module.exports = mongoose.model('FinanceBudgetNoticeSetting', financeBudgetNoticeSettingSchema);
