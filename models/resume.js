const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const resumeSchema = new Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  last_name: { type: String },
  first_name: { type: String },
  last_name_kana: { type: String },
  first_name_kana: { type: String },
  zip: { type: String },
  prefecture: { type: String },
  city: { type: String },
  address_detail: { type: String },
  home_phone: { type: String },
  mobile_phone: { type: String },
  summary: { type: String },
  skills: { type: String },
  experience: { type: String },
  self_promotion: { type: String },
  photo_url: { type: String },
  entry_date: { type: Date, default: Date.now },
  update_date: { type: Date },
  isPublished: { type: Boolean,default: false},
  isrPublished: { type: Boolean,default: false},
  ispPublished: { type: Boolean,default: false}
});

// 更新時の update_date 自動更新
resumeSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Resume = mongoose.model('Resume', resumeSchema);
module.exports = Resume;