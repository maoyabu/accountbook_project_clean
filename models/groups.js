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
  }, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema);