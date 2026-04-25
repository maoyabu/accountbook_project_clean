const crypto = require('crypto');
const mongoose = require('mongoose');

const algorithm = 'aes-256-cbc';
const secret = process.env.MESSAGE_SECRET || process.env.SECURE_NOTE_SECRET || 'default_message_secret';

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

const messageItemSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String
  },
  url: {
    type: String
  },
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
  is_active: {
    type: Boolean,
    default: true
  },
  start_date: {
    type: Date
  },
  end_date: {
    type: Date
  },
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
  entry_date: {
    type: Date,
    default: Date.now
  },
  update_date: {
    type: Date
  }
});

messageItemSchema.pre('save', function (next) {
  if (this.isModified('content') && this.content) {
    this.content = encryptText(this.content);
  }
  this.update_date = new Date();
  next();
});

messageItemSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate() || {};
  if (update.content) {
    update.content = encryptText(update.content);
  }
  update.update_date = new Date();
  this.setUpdate(update);
  next();
});

messageItemSchema.methods.decryptContent = function () {
  return decryptText(this.content);
};

const MessageItem = mongoose.model('MessageItem', messageItemSchema);
module.exports = MessageItem;
