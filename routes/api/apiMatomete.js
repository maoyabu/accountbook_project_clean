// routes/api/apiMatomete.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const RegularEntry = require('../../models/finance_regularEntry');
const Finance = require('../../models/finance');
const MatometeStatus = require('../../models/matomete_status');

function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

router.use(requireLogin);

function normalizeCfToEnglish(cfRaw) {
  const cf = String(cfRaw || '').trim().toLowerCase();
  switch (cf) {
    case '収入':
    case '収入項目':
    case 'income':
      return 'income';
    case '控除':
    case '控除項目':
    case 'deduction':
      return 'deduction';
    case '貯蓄':
    case '貯蓄項目':
    case 'saving':
      return 'saving';
    case '支出':
    case 'expense':
      return 'expense';
    default:
      return cf;
  }
}

function cfToJapanese(cfRaw) {
  const v = String(cfRaw || '').trim().toLowerCase();
  switch (v) {
    case 'income': return '収入';
    case 'saving': return '貯蓄';
    case 'deduction': return '控除';
    case 'expense': return '支出';
    case '収入': return '収入';
    case '貯蓄': return '貯蓄';
    case '控除': return '控除';
    case '支出': return '支出';
    default: return '';
  }
}

function resolveCategoryByCf(entry) {
  const cf = normalizeCfToEnglish(entry.cf);
  if (cf === 'income') return String(entry.income_item || '');
  if (cf === 'deduction') return String(entry.dedu_item || '');
  if (cf === 'saving') return String(entry.saving_item || '');
  return String(entry.expense_item || '');
}

function ensureObjectId(value) {
  if (mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(value);
  return value;
}

function yearMonthFromYm(ym) {
  const [yearStr, monthStr] = String(ym || '').split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  if (!year || !month) return null;
  return { year, month };
}

function makeKey(entry) {
  return `${entry.cf || ''}_${entry.content || ''}_${Number(entry.amount || 0)}`;
}

// GET /api/matomete/status?group=GROUP_ID&ym=YYYY-MM
router.get('/status', async (req, res) => {
  try {
    const groupIdRaw = String(req.query.group || '').trim();
    const ym = String(req.query.ym || '').trim();
    if (!groupIdRaw || !ym) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym は必須です' });
    }

    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);

    const status = await MatometeStatus.findOne({ user: userId, group: groupId, month: ym }).lean();
    return res.json({
      completed: status?.completed === true,
      completedAt: status?.completedAt || null,
      month: ym
    });
  } catch (err) {
    console.error('❌ matomete status api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// GET /api/matomete/regular-entry?group=GROUP_ID
router.get('/regular-entry', async (req, res) => {
  try {
    const groupIdRaw = String(req.query.group || '').trim();
    const ym = String(req.query.ym || '').trim();
    if (!groupIdRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }

    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);

    const query = { group: groupId, user: userId, isDisabled: { $ne: true } };
    if (ym) {
      query.$or = [
        { month: ym },
        { month: { $exists: false } },
        { month: '' }
      ];
    }

    const entries = await RegularEntry.find(query).lean();

    const items = entries.map(entry => {
      const cf = normalizeCfToEnglish(entry.cf);
      return {
        id: String(entry._id),
        item: resolveCategoryByCf(entry),
        category: resolveCategoryByCf(entry),
        amount: Number(entry.amount || 0),
        cf,
        paymentType: entry.payment_type || '',
        memberId: entry.member_id || '',
        memo: entry.memo || '',
        content: entry.content || '',
        month: entry.month || ''
      };
    });

    return res.json({ items });
  } catch (err) {
    console.error('❌ regular-entry api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// GET /api/matomete/regular-entry/manage?group=GROUP_ID&ym=YYYY-MM
router.get('/regular-entry/manage', async (req, res) => {
  try {
    const groupIdRaw = String(req.query.group || '').trim();
    const ym = String(req.query.ym || '').trim();
    if (!groupIdRaw || !ym) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym は必須です' });
    }

    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);

    const entries = await RegularEntry.find({
      group: groupId,
      user: userId,
      isDisabled: { $ne: true },
      $or: [
        { month: ym },
        { month: { $exists: false } },
        { month: '' }
      ]
    }).lean();
    const items = entries.map(entry => ({
      id: String(entry._id),
      cf: normalizeCfToEnglish(entry.cf),
      category: resolveCategoryByCf(entry),
      day: Number(entry.day || 1),
      amount: Number(entry.amount || 0),
      paymentType: entry.payment_type || '',
      content: entry.content || '',
      month: entry.month || ym
    }));

    return res.json({ items });
  } catch (err) {
    console.error('❌ regular-entry manage api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// POST /api/matomete/regular-entry/create
router.post('/regular-entry/create', async (req, res) => {
  try {
    const groupIdRaw = String(req.body.group || '').trim();
    const ym = String(req.body.ym || '').trim();
    const cfRaw = String(req.body.cf || '').trim();
    const category = String(req.body.category || '').trim();
    const day = Number(req.body.day || 1);
    const amount = Number(req.body.amount || 0);
    const paymentType = String(req.body.paymentType || '').trim();
    const content = String(req.body.content || '').trim();

    if (!groupIdRaw || !ym || !category || !cfRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym, cf, category は必須です' });
    }

    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);
    const cfJp = cfToJapanese(cfRaw);

    const payload = {
      cf: cfJp,
      income_item: cfRaw === 'income' ? category : '',
      expense_item: cfRaw === 'expense' ? category : '',
      dedu_item: cfRaw === 'deduction' ? category : '',
      saving_item: cfRaw === 'saving' ? category : '',
      content,
      amount,
      payment_type: paymentType,
      user: userId,
      group: groupId,
      day,
      month: ym,
      isDisabled: false,
      disabledAt: null,
      disabledBy: null
    };

    await RegularEntry.create(payload);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ regular-entry create api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// PUT /api/matomete/regular-entry/:id
router.put('/regular-entry/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const groupIdRaw = String(req.body.group || '').trim();
    const ym = String(req.body.ym || '').trim();
    const cfRaw = String(req.body.cf || '').trim();
    const category = String(req.body.category || '').trim();
    const day = Number(req.body.day || 1);
    const amount = Number(req.body.amount || 0);
    const paymentType = String(req.body.paymentType || '').trim();
    const content = String(req.body.content || '').trim();

    if (!id || !groupIdRaw || !ym || !category || !cfRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'id, group, ym, cf, category は必須です' });
    }

    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);
    const cfJp = cfToJapanese(cfRaw);

    const payload = {
      cf: cfJp,
      income_item: cfRaw === 'income' ? category : '',
      expense_item: cfRaw === 'expense' ? category : '',
      dedu_item: cfRaw === 'deduction' ? category : '',
      saving_item: cfRaw === 'saving' ? category : '',
      content,
      amount,
      payment_type: paymentType,
      day,
      month: ym
    };

    await RegularEntry.findOneAndUpdate(
      { _id: id, user: userId, group: groupId, isDisabled: { $ne: true } },
      payload,
      { new: true }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ regular-entry update api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// DELETE /api/matomete/regular-entry/:id
router.delete('/regular-entry/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const groupIdRaw = String(req.query.group || '').trim();
    if (!id || !groupIdRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'id, group は必須です' });
    }
    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);
    await RegularEntry.findOneAndUpdate(
      { _id: id, user: userId, group: groupId, isDisabled: { $ne: true } },
      {
        isDisabled: true,
        disabledAt: new Date(),
        disabledBy: userId,
        update_date: new Date()
      },
      { new: true }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ regular-entry delete api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// POST /api/matomete/regular-entry/update
router.post('/regular-entry/update', async (req, res) => {
  try {
    const groupIdRaw = String(req.body.group || '').trim();
    const ym = String(req.body.ym || req.body.targetMonth || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!groupIdRaw || !ym || items.length === 0) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym, items は必須です' });
    }

    const yearMonth = yearMonthFromYm(ym);
    if (!yearMonth) {
      return res.status(400).json({ error: 'invalid_params', message: 'ym の形式が不正です' });
    }

    const { year, month } = yearMonth;
    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);

    const [existingEntries, allRegulars] = await Promise.all([
      Finance.find({ group: groupId, user: userId, date: { $gte: startOfMonth, $lte: endOfMonth } }).lean(),
      RegularEntry.find({ group: groupId, user: userId, isDisabled: { $ne: true } }).lean()
    ]);

    const existingKeys = new Set(existingEntries.map(makeKey));
    const regularEntriesMap = {};
    allRegulars.forEach(entry => {
      regularEntriesMap[String(entry._id)] = entry;
    });

    const enrichedItems = items.map(e => {
      const source = regularEntriesMap[String(e.id || '')];
      if (!source) return null;
      return {
        id: String(source._id),
        cf: source.cf,
        content: source.content,
        amount: Number(e.amount || source.amount || 0),
        payment_type: source.payment_type,
        income_item: source.income_item || '',
        expense_item: source.expense_item || '',
        dedu_item: source.dedu_item || '',
        saving_item: source.saving_item || '',
        day: source.day || 1,
        skip: e.skip === true || e.skip === 'true' || e.skip === '1'
      };
    }).filter(Boolean);

    const duplicates = enrichedItems
      .filter(e => existingKeys.has(makeKey(e)))
      .map(e => ({
        id: e.id,
        date: new Date(Date.UTC(year, month - 1, e.day || 1)),
        category: e.expense_item || e.income_item || e.dedu_item || e.saving_item || '',
        amount: Number(e.amount || 0),
        memo: '',
        content: e.content || '',
        paymentType: e.payment_type || ''
      }));

    if (duplicates.length > 0) {
      return res.json({ hasDuplicates: true, duplicates });
    }

    const newEntries = enrichedItems
      .filter(e => !e.skip)
      .map(e => ({
        cf: cfToJapanese(e.cf),
        income_item: e.income_item || '',
        expense_item: e.expense_item || '',
        dedu_item: e.dedu_item || '',
        saving_item: e.saving_item || '',
        content: e.content || '',
        amount: Number(e.amount || 0),
        payment_type: e.payment_type || '',
        user: userId,
        group: groupId,
        date: new Date(Date.UTC(year, month - 1, e.day || 1)),
        month,
        day: e.day || 1,
        entry_date: new Date(),
        update_date: new Date()
      }));

    if (newEntries.length > 0) {
      await Finance.insertMany(newEntries);
    }

    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    await MatometeStatus.findOneAndUpdate(
      { user: userId, group: groupId, month: monthKey },
      { completed: true, completedAt: new Date() },
      { upsert: true, new: true }
    );

    return res.json({ hasDuplicates: false, message: 'まとめて入力を完了しました' });
  } catch (err) {
    console.error('❌ regular-entry update api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

// POST /api/matomete/regular-entry/update/confirm
router.post('/regular-entry/update/confirm', async (req, res) => {
  try {
    const groupIdRaw = String(req.body.group || '').trim();
    const ym = String(req.body.ym || req.body.targetMonth || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!groupIdRaw || !ym || items.length === 0) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym, items は必須です' });
    }

    const yearMonth = yearMonthFromYm(ym);
    if (!yearMonth) {
      return res.status(400).json({ error: 'invalid_params', message: 'ym の形式が不正です' });
    }

    const { year, month } = yearMonth;
    const userId = ensureObjectId(req.user._id);
    const groupId = ensureObjectId(groupIdRaw);

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);

    const [existingEntries, allRegulars] = await Promise.all([
      Finance.find({ group: groupId, user: userId, date: { $gte: startOfMonth, $lte: endOfMonth } }).lean(),
      RegularEntry.find({ group: groupId, user: userId, isDisabled: { $ne: true } }).lean()
    ]);

    const regularEntriesMap = {};
    allRegulars.forEach(entry => {
      regularEntriesMap[String(entry._id)] = entry;
    });

    const existingByKey = existingEntries.reduce((acc, entry) => {
      const key = makeKey(entry);
      if (!acc[key]) acc[key] = [];
      acc[key].push(entry);
      return acc;
    }, {});

    const normalizedEntries = items
      .map(e => {
        const source = regularEntriesMap[String(e.id || '')];
        if (!source) return null;
        const amountNum = Number(e.amount || source.amount || 0);
        const day = source.day || 1;
        const payload = {
          cf: cfToJapanese(source.cf),
          income_item: source.income_item || '',
          expense_item: source.expense_item || '',
          dedu_item: source.dedu_item || '',
          saving_item: source.saving_item || '',
          content: source.content || '',
          amount: amountNum,
          payment_type: source.payment_type || '',
          user: userId,
          group: groupId,
          date: new Date(Date.UTC(year, month - 1, day)),
          month,
          day
        };
        return {
          key: makeKey(payload),
          payload,
          skip: e.skip === true || e.skip === 'true' || e.skip === '1'
        };
      })
      .filter(Boolean);

    const updates = [];
    const inserts = [];
    const updatedKeys = new Set();

    normalizedEntries.forEach(entry => {
      if (entry.skip) return;
      const existingList = existingByKey[entry.key];
      if (existingList && !updatedKeys.has(entry.key)) {
        updatedKeys.add(entry.key);
        existingList.forEach(doc => {
          updates.push({
            id: doc._id,
            payload: { ...entry.payload }
          });
        });
      } else if (!existingList) {
        inserts.push({
          ...entry.payload,
          entry_date: new Date(),
          update_date: new Date()
        });
      }
    });

    if (updates.length > 0) {
      await Promise.all(
        updates.map(u => Finance.findByIdAndUpdate(u.id, { ...u.payload, update_date: new Date() }, { new: true }))
      );
    }

    if (inserts.length > 0) {
      await Finance.insertMany(inserts);
    }

    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    await MatometeStatus.findOneAndUpdate(
      { user: userId, group: groupId, month: monthKey },
      { completed: true, completedAt: new Date() },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, message: 'まとめて入力を完了しました' });
  } catch (err) {
    console.error('❌ regular-entry confirm api error:', err);
    return res.status(500).json({ error: 'server_error', message: '内部エラーが発生しました' });
  }
});

module.exports = router;
