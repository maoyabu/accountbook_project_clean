const mongoose = require('mongoose');
const { Schema } = mongoose;

const reflectionCommentSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
}, { _id: true });

const financeMonthlyReflectionSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  fiscalYear: { type: Number, required: true, index: true },
  year: { type: Number, required: true, index: true },
  month: { type: Number, required: true, min: 1, max: 12, index: true },
  ym: { type: String, required: true, index: true },
  item: { type: String, required: true, trim: true, index: true },
  comments: { type: [reflectionCommentSchema], default: [] }
}, { timestamps: true });

financeMonthlyReflectionSchema.index(
  { group: 1, ym: 1, item: 1 },
  { unique: true }
);

module.exports = mongoose.model('FinanceMonthlyReflection', financeMonthlyReflectionSchema);
