const express = require('express');
const mongoose = require('mongoose');
const { categoryFields, cleanOptions, validDate, validateValues, payloadFromValues } = require('../Utils/financeCompactState');
module.exports = function createCompactRouter(deps) {
  const { isLoggedIn, getFinanceEditableGroupsForUser, buildFinanceFormOptions, getGroupFiscalStartMonth,
    resolveFiscalYearForValue, buildDuplicateQuery, sanitizeReturnPath, logAction } = deps;
  const Finance = deps.Finance || require('../models/finance');
  const FinanceUser = deps.FinanceUser || require('../models/users');
  const PaymentItem = deps.PaymentItem || require('../models/paymentItems');
  const router = express.Router();
  const idOf = value => String(value?._id || value || '');
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function context(req, groupId, userId, date, preserve = null, allowFallback = false) {
    const actor = await getFinanceEditableGroupsForUser(req.user._id);
    if (!actor.availableGroupIds.has(groupId)) { const err = new Error('このグループを利用できません'); err.status = 403; throw err; }
    const fiscalStart = await getGroupFiscalStartMonth(groupId);
    const options = await buildFinanceFormOptions({ groupId, userId, year: resolveFiscalYearForValue(date, fiscalStart), preserveValues: preserve });
    // Do not retain a previous user from outside the selected group.
    const users = options.allUsers.filter(user => Array.isArray(user.groups) ? user.groups.some(group => idOf(group) === groupId) : true);
    if (allowFallback && !users.some(user => idOf(user) === userId)) userId = idOf(users.find(user => idOf(user) === idOf(req.user)) || users[0]);
    if (!users.some(user => idOf(user) === userId)) { const err = new Error('このグループの使用者を選んでください'); err.status = 400; throw err; }
    const payments = await PaymentItem.find({ group: groupId, user: userId }).sort({ display_order: 1, paymentItem: 1 });
    return {
      userId,
      groups: actor.availableGroups.map(group => ({ id: idOf(group), name: group.group_name })),
      users: users.map(user => ({ id: idOf(user), name: user.displayname || user.username })),
      categories: { 支出: cleanOptions(options.ex_cfs), 収入: cleanOptions(options.in_items), 控除: cleanOptions(options.dedu_cfs), 貯蓄: cleanOptions(options.saving_cfs) },
      payments: cleanOptions(payments.map(item => item.paymentItem)), commonTags: options.common_tags || []
    };
  }
  async function editable(req, id) {
    if (!mongoose.Types.ObjectId.isValid(id)) { const err = new Error('無効な明細IDです'); err.status = 400; throw err; }
    const finance = await Finance.findById(id);
    const actor = await getFinanceEditableGroupsForUser(req.user._id);
    if (!finance || !actor.availableGroupIds.has(idOf(finance.group))) { const err = new Error('この明細を編集できません'); err.status = 403; throw err; }
    return finance;
  }
  function sendError(res, err) { return res.status(err.status || 500).json({ ok: false, message: err.status ? err.message : '処理に失敗しました。入力内容を保持したまま再度お試しください' }); }
  router.post('/budget/entry-mode', isLoggedIn, wrap(async (req, res) => {
    const mode = req.body.financeEntryMode;
    if (!['step', 'list'].includes(mode)) return res.status(400).send('入力方式を選択してください');
    await FinanceUser.findByIdAndUpdate(req.user._id, { financeEntryMode: mode });
    req.flash('success', `新規登録を「${mode === 'list' ? '一覧方式' : 'ステップ方式'}」に変更しました`);
    res.redirect('/finance/budget');
  }));
  router.get('/entry-step', isLoggedIn, (req, res) => {
    const query = new URLSearchParams();
    for (const key of ['from', 'modal', 'returnTo']) if (typeof req.query[key] === 'string') query.set(key, req.query[key]);
    res.redirect(`/finance/entry${query.size ? `?${query}` : ''}`);
  });
  async function renderNew(req, res, conversation = false) {
    const groupId = idOf(req.session.activeGroupId);
    if (!groupId) return res.redirect('/group_list');
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const values = { groupId, userId: idOf(req.user), date: today, cf: '', category: '', sub_tag: '', content: '', amount: '', payment_type: '' };
    let continuing = false;
    if (req.query.from) {
      const source = await editable(req, req.query.from);
      Object.assign(values, { date: source.date.toISOString().slice(0, 10), cf: source.cf, category: source[categoryFields[source.cf]] || '' });
      continuing = true;
    }
    const options = await context(req, groupId, values.userId, values.date);
    if (!(options.categories[values.cf] || []).includes(values.category)) values.category = '';
    res.render('finance/compact', { compactData: { mode: 'new', conversation, entryMode: !conversation && req.user.financeEntryMode === 'list' ? 'list' : 'step', values, options, continuing, reviewing: continuing, tagEnabled: req.user.financeTagRegistrationEnabled === true, returnTo: sanitizeReturnPath(req.query.returnTo, '/finance/list') }, embedded: req.query.modal === '1' });
  }
  router.get('/entry', isLoggedIn, wrap((req, res) => renderNew(req, res)));
  router.get('/entry-conversation', isLoggedIn, wrap((req, res) => renderNew(req, res, true)));
  router.get('/entry-step/options', isLoggedIn, async (req, res) => {
    try {
      if (!validDate(req.query.date)) return res.status(400).json({ ok: false, message: '有効な日付を入力してください' });
      const groupId = idOf(req.query.groupId), userId = idOf(req.query.userId);
      res.json({ ok: true, options: await context(req, groupId, userId, req.query.date, null, true) });
    } catch (err) { sendError(res, err); }
  });
  router.get('/:id/compact', isLoggedIn, wrap(async (req, res) => {
    const finance = await editable(req, req.params.id);
    const values = { groupId: idOf(finance.group), userId: idOf(finance.user), date: finance.date.toISOString().slice(0, 10), cf: finance.cf,
      category: finance[categoryFields[finance.cf]] || '', sub_tag: finance.sub_tag || '', content: finance.content || '', amount: finance.amount, payment_type: finance.payment_type || '' };
    const options = await context(req, values.groupId, values.userId, values.date, finance.toObject(), true);
    if (options.userId !== values.userId) { values.userId = options.userId; values.payment_type = ''; }
    res.render('finance/compact', { compactData: { mode: 'edit', id: idOf(finance), values, options, tagEnabled: req.user.financeTagRegistrationEnabled === true,
      returnTo: sanitizeReturnPath(req.query.returnTo, '/finance/list') }, embedded: req.query.modal === '1' });
  }));
  // Previously opened forms and conversation input now confirm in the same compact screen.
  async function reviewForm(req, res) {
    const original = req.params.id ? await editable(req, req.params.id) : null;
    const form = req.body.finance || {};
    const groupId = original ? idOf(form.group || original.group) : idOf(req.session.activeGroupId);
    if (!groupId) return res.redirect('/group_list');
    const date = validDate(form.date) ? form.date : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    const userId = original ? idOf(form.user || original.user) : idOf(req.user);
    const options = await context(req, groupId, userId, date, original?.toObject(), true);
    const values = { groupId, userId: options.userId, date, cf: form.cf || '',
      category: Object.hasOwn(categoryFields, form.cf) ? form[categoryFields[form.cf]] || '' : '',
      sub_tag: typeof form.sub_tag === 'string' ? form.sub_tag : '', content: typeof form.content === 'string' ? form.content : '',
      amount: typeof form.amount === 'string' || typeof form.amount === 'number' ? form.amount : '', payment_type: typeof form.payment_type === 'string' ? form.payment_type : '' };
    res.render('finance/compact', { compactData: { mode: original ? 'edit' : 'new', id: original ? idOf(original) : undefined,
      values, options, reviewing: true, continueConversation: req.body.nextAction === 'conversation', tagEnabled: req.user.financeTagRegistrationEnabled === true,
      returnTo: sanitizeReturnPath(req.body.returnTo, '/finance/list') }, embedded: req.body.financeEditModal === '1' });
  }
  router.post('/entry', isLoggedIn, wrap(reviewForm));
  router.put('/:id', isLoggedIn, wrap(reviewForm));
  async function save(req, res) {
    try {
      const original = req.params.id ? await editable(req, req.params.id) : null;
      const copy = original && req.body.copy === true;
      const values = { ...(req.body.values || {}) };
      if (!original) { values.groupId = idOf(req.session.activeGroupId); values.userId = idOf(req.user); }
      if (!validDate(values.date)) return res.status(400).json({ ok: false, errors: { date: '有効な年月日を入力してください' } });
      const sameContext = original && idOf(original.group) === values.groupId && idOf(original.user) === values.userId;
      const options = await context(req, values.groupId, values.userId, values.date, sameContext ? original.toObject() : null);
      const errors = validateValues(values, options);
      if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });
      const payload = { ...payloadFromValues(values, req.user.financeTagRegistrationEnabled === true), user: values.userId, group: values.groupId };
      const duplicateQuery = buildDuplicateQuery(payload);
      if (original && !copy) duplicateQuery._id = { $ne: original._id };
      if (!req.body.confirmDuplicate && await Finance.findOne(duplicateQuery)) return res.status(409).json({ ok: false, duplicate: true, message: '同じ内容の入力があります。この内容で保存しますか？' });
      let saved;
      if (original && !copy) {
        Object.assign(original, payload, { update_date: new Date() });
        saved = await original.save();
      } else {
        saved = await new Finance({ ...payload, entry_date: new Date(), update_date: new Date(), tags: [], memo: copy ? original.memo || '' : '' }).save();
      }
      await logAction({ req, action: original ? (copy ? '複製' : '更新') : '登録', target: '家計簿' });
      res.json({ ok: true, id: idOf(saved), continueUrl: `/finance/entry?from=${encodeURIComponent(idOf(saved))}` });
    } catch (err) { sendError(res, err); }
  }
  router.post('/entry-step', isLoggedIn, save);
  router.post('/:id/compact', isLoggedIn, save);
  return router;
};
