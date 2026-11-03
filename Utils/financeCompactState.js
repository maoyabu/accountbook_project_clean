const categoryFields = { 支出: 'expense_item', 収入: 'income_item', 控除: 'dedu_item', 貯蓄: 'saving_item' };
const cleanOptions = items => [...new Set((items || []).filter(value => typeof value === 'string' && value && value !== 'Please Choice'))];
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateValues(values, options) {
  const errors = {};
  if (!validDate(values.date)) errors.date = '有効な年月日を入力してください';
  if (!Object.hasOwn(categoryFields, values.cf)) errors.cf = '収支区分を選んでください';
  if (!(Object.hasOwn(options.categories, values.cf) ? options.categories[values.cf] : []).includes(values.category)) errors.category = '詳細区分を選んでください';
  if (typeof values.content !== 'string' || !values.content.trim()) errors.content = '内容を入力してください';
  if (!['string', 'number'].includes(typeof values.amount) || String(values.amount).trim() === '' || !Number.isFinite(Number(values.amount))) errors.amount = '金額を数字で入力してください';
  if (!options.payments.includes(values.payment_type)) errors.payment_type = '使用者の支払種別を選んでください';
  return errors;
}
function payloadFromValues(values, tagEnabled) {
  return {
    date: new Date(values.date), month: Number(values.date.slice(5, 7)), day: Number(values.date.slice(8, 10)),
    cf: values.cf, ...Object.fromEntries(Object.values(categoryFields).map(field => [field, ''])),
    [categoryFields[values.cf]]: values.category,
    content: values.content.trim(), amount: Number(values.amount), payment_type: values.payment_type,
    ...(tagEnabled ? { sub_tag: String(values.sub_tag || '').trim().slice(0, 100) } : {})
  };
}
module.exports = { categoryFields, cleanOptions, validDate, validateValues, payloadFromValues };
