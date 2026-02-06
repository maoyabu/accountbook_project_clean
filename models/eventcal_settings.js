const mongoose = require('mongoose');

const eventcalSettingsSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true
  },
  excludeWords: {
    type: [String],
    default: []
  },
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  }
});

eventcalSettingsSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Eventcal_settings = mongoose.model('eventcal_settings', eventcalSettingsSchema);
module.exports = Eventcal_settings;
