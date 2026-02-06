const mongoose = require('mongoose');

const photoSchema = new mongoose.Schema({
    mediaItemId: { type: String },  // Google Photos の mediaItemId
    baseUrl:     { type: String },  // 取得時に組み立てた画像URL
    description: { type: String },   // （オプションでキャプションなど）
    order:       { type: Number, default: 0 }
});

const eventcalSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    item: {
        type: String,
        required: true
    },
    event: {
        type: String,
        ref:'eventcal_events',
        required: true
    },
    rate: {
        type: Number,
        required: true
    },
    title: {
        type: String
    },
    content: {
        type: String
    },
    summary: {
        type: String
    },
    tags: [
    {
        name: String,
        score: Number
    }
    ],
    photos: [
    {
        url: String,
        source: { type: String, enum: ['local', 'google', 'cloudinary'], default: 'local' }
    }
    ],
    share: { type: Boolean, default: true },
    saveAction: { type: String, enum: ['draft', 'final'], default: 'final' },
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

// 🔹 更新時に update_date を自動設定する
eventcalSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Eventcal = mongoose.model('Eventcal',eventcalSchema);
module.exports = Eventcal;
