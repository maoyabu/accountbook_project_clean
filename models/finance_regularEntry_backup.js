const mongoose = require('mongoose');

const regularEntrySnapshotSchema = new mongoose.Schema({
  originalId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  day: { type: Number },
  month: { type: String },
  cf: { type: String, required: true },
  income_item: { type: String },
  expense_item: { type: String },
  dedu_item: { type: String },
  saving_item: { type: String },
  content: { type: String },
  amount: { type: Number, required: true },
  payment_type: { type: String, required: true },
  isDisabled: { type: Boolean, default: false },
  disabledAt: { type: Date },
  disabledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  entry_date: { type: Date },
  update_date: { type: Date }
}, { _id: false });

const regularEntryBackupSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  backupType: {
    type: String,
    enum: ['manual', 'delete'],
    default: 'manual'
  },
  backupName: {
    type: String,
    default: ''
  },
  entryCount: {
    type: Number,
    default: 0
  },
  entries: {
    type: [regularEntrySnapshotSchema],
    default: []
  },
  entry_date: {
    type: Date,
    default: Date.now
  }
});

regularEntryBackupSchema.index({ group: 1, user: 1, entry_date: -1 });

module.exports = mongoose.model('RegularEntryBackup', regularEntryBackupSchema);
