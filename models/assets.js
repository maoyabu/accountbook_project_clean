const crypto = require('crypto');
const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema({
    asset_cf: {
        type: String,
        required: true
    },
    asset_item: {
        type: String,
        required: true
    },
    code: {
        type: String
    },
    content: {
        type: String,
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    monetary_unit: {
        type: String,
        required: true
    },
    secure_note: {
        type: String,
        default: '',
        select: false  // 通常の.find()や.findOne()では取得されないようにする
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
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定し、secure_note を暗号化する
assetSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate();
    if (update.secure_note) {
        const iv = crypto.randomBytes(16);
        const key = crypto.createHash('sha256').update(String(process.env.SECURE_NOTE_SECRET)).digest();
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(update.secure_note, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        update.secure_note = iv.toString('hex') + ':' + encrypted;
        this.setUpdate(update);
    }
    update.update_date = Date.now();
    next();
});

// 🔒 保存時に secure_note を暗号化する
assetSchema.pre('save', function (next) {
    if (this.isModified('secure_note') && this.secure_note) {
        const iv = crypto.randomBytes(16);
        const key = crypto.createHash('sha256').update(String(process.env.SECURE_NOTE_SECRET)).digest();
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(this.secure_note, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        this.secure_note = iv.toString('hex') + ':' + encrypted;
    }
    next();
});

assetSchema.methods.decryptSecureNote = function () {
    if (!this.secure_note) return '';

    const [ivHex, encrypted] = this.secure_note.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(String(process.env.SECURE_NOTE_SECRET)).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
};

const Asset = mongoose.model('Asset',assetSchema);
module.exports = Asset;