const mongoose = require('mongoose');
const { Schema } = mongoose;

const matometeStatusSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  month: { type: String, required: true, index: true }, // YYYY-MM
  completed: { type: Boolean, default: false },
  completedAt: { type: Date },
  reminderSentAt: { type: Date }
});

matometeStatusSchema.index({ user: 1, group: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('MatometeStatus', matometeStatusSchema);
