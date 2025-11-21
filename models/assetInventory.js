const mongoose = require('mongoose');

const inventoryItemSchema = new mongoose.Schema({
  asset: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Asset'
  },
  asset_cf: String,
  asset_item: String,
  code: String,
  content: String,
  amount: {
    type: Number,
    default: 0
  },
  amountYen: {
    type: Number,
    default: 0
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedAt: {
    type: Date
  }
});

const assetInventorySchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true
    },
    inventoryMonth: {
      type: Date,
      required: true
    },
    items: [inventoryItemSchema],
    totalYen: {
      type: Number,
      default: 0
    },
    totalByCf: {
      type: Map,
      of: Number,
      default: {}
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

assetInventorySchema.index({ group: 1, inventoryMonth: 1 }, { unique: true });

module.exports = mongoose.model('AssetInventory', assetInventorySchema);
