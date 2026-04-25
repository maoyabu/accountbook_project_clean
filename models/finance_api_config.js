const mongoose = require('mongoose');
const { Schema } = mongoose;

const financeApiConfigSchema = new Schema({
  url: {
    type: String,
    required: true
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

module.exports = mongoose.model('FinanceApiConfig', financeApiConfigSchema);
