const mongoose = require('mongoose');

const infoSchema = new mongoose.Schema({
    info_title: { type: String, required: true },
    info_content: { type: String }, // HTML内容
    app_url: { type: String, required: true },
    guide_url: { type: String },

    pub_target: {
        type: String,
        required: true
    },

    target_group: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group'
    },

    mail_delivery: { type: Boolean },
    mail_sent: { type: Boolean, default: false },

    entry_date: { type: Date, default: Date.now },
    update_date: { type: Date },

    from_date: { type: Date },
    end_date: { type: Date }
});

infoSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() });
    next();
});

const Info = mongoose.model('Info', infoSchema);
module.exports = Info;