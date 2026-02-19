const mongoose = require('mongoose');
const { Schema } = mongoose;

const groupSchema = new Schema({
    group_name: {
        type: String,
        required: true,
        unique: true
    },
    createdBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: []
      }],
    invitedUsers: {
        type: [String],
        default: []
      },
    financeFiscalStartMonth: {
        type: Number,
        default: 1,
        min: 1,
        max: 12
    },
    financeWalletManagementEnabled: {
        type: Boolean,
        default: false
    }
  }, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema);
