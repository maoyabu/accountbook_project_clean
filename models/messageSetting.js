const mongoose = require('mongoose');
const crypto = require('crypto');

const algorithm = 'aes-256-cbc';
const secret = process.env.MESSAGE_PASSWORD_SECRET || process.env.SECURE_NOTE_SECRET || 'default_message_password_secret';

const encryptText = (text) => {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
};

const decryptText = (encrypted) => {
  if (!encrypted) return '';
  if (encrypted.startsWith('$2')) return '';
  const parts = encrypted.split(':');
  if (parts.length !== 2) return '';
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const isEncrypted = (value) => typeof value === 'string' && value.includes(':') && !value.startsWith('$2');

const messageSettingSchema = new mongoose.Schema({
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
  service_enabled: {
    type: Boolean,
    default: false
  },
  confirm_period_days: {
    type: Number,
    default: 30
  },
  final_notice_days: {
    type: Number,
    default: 7
  },
  view_password: {
    type: String
  },
  confirm_methods: [{
    type: String,
    enum: ['email', 'line', 'push']
  }],
  confirm_emails: [{
    type: String
  }],
  confirm_line_id: {
    type: String
  },
  confirm_targets: [{
    method: {
      type: String,
      enum: ['email', 'line', 'push']
    },
    destination: {
      type: String
    }
  }],
  share_scope: {
    type: String,
    enum: ['private', 'all', 'selected'],
    default: 'private'
  },
  shared_members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: []
  }],
  message_body: {
    type: String
  },
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  }
});

messageSettingSchema.pre('save', async function (next) {
  if (this.isModified('view_password') && this.view_password && !isEncrypted(this.view_password)) {
    this.view_password = encryptText(this.view_password);
  }
  this.update_date = new Date();
  next();
});

messageSettingSchema.pre('findOneAndUpdate', async function (next) {
  const update = this.getUpdate() || {};
  if (update.view_password && !isEncrypted(update.view_password)) {
    update.view_password = encryptText(update.view_password);
  }
  update.update_date = new Date();
  this.setUpdate(update);
  next();
});

messageSettingSchema.methods.decryptViewPassword = function () {
  return decryptText(this.view_password);
};

const MessageSetting = mongoose.model('MessageSetting', messageSettingSchema);
module.exports = MessageSetting;
