const mongoose = require('mongoose');

const ingredientsSchema = new mongoose.Schema({
    ingredient: {
        type: String,
        required: true
    },
    classification: {
        type: String
    },
    energy: {
        type: String
    },
    water: {
        type: String
    },
    protein: {
        type: String
    },
    lipid: {
        type: String
    },
    carbohydrate: {
        type: String
    },
    unit: {
        type: [String]  // 例: ['g', 'ml']
    },
    season: {
        type: [String]  // 例: ['春', '夏']
    },
    month: {
        type: [String]  // 例: ['3月', '4月']
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
ingredientsSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Ingredients = mongoose.model('Ingredients',ingredientsSchema);
module.exports = Ingredients;