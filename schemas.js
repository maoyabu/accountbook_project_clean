const Joi = require('joi');

//finance用のスキーマ
module.exports.financeSchema = Joi.object({
    date: Joi.date().required(),
    month: Joi.number().optional(),
    day: Joi.number().optional(),
    cf: Joi.string().required(),
    income_item: Joi.string(),
    expense_item: Joi.string(),
    dedu_item: Joi.string(),
    content: Joi.string(),
    amount: Joi.number().required(),
    payment_type: Joi.string().required(),
    user: Joi.string().required(),
    entry_date: Joi.date().default(Date.now),
    update_date: Joi.date()
});