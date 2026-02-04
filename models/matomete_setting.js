const mongoose = require('mongoose');
const { Schema } = mongoose;

const matometeSettingSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  reminderDays: { type: Number, default: 7 }
});

matometeSettingSchema.index({ group: 1 }, { unique: true });

module.exports = mongoose.model('MatometeSetting', matometeSettingSchema);
