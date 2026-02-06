const mongoose = require('mongoose');

const eventcal_eventsSchema = new mongoose.Schema({
    display_order: {
        type: Number,
        required: true,
        default: 0
    },
    item: {
        type: String,
        required: true
    },
    event: {
        type: String,
        required: true
    },
    excludeFromTags: {
        type: Boolean,
        default: false
    },
    showInEntryDropdown: {
        type: Boolean,
        default: true
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

// 🔹 更新時に update_date を自動設定する
eventcal_eventsSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Eventcal_events = mongoose.model('Eventcal_events',eventcal_eventsSchema);
module.exports = Eventcal_events;
