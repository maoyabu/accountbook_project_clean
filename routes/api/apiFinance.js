// routes/api/apiFinance.js
const express = require('express');
const router = express.Router();
const Finance = require('../../models/finance');
const Budget = require('../../models/finance_ex_budget');      // 予算(支出)マスタ
const Item = require('../../models/finance_items');            // 収入/控除/貯蓄アイテム
const PaymentItem = require('../../models/paymentItems');      // 支払種別
const Group = require('../../models/groups');                  // グループ
const User = require('../../models/users');                    // ユーザー

// 共通ログ
router.use((req, res, next) => {
  console.log('[api/finance]', req.method, req.originalUrl, 'Cookie:', req.headers.cookie || '(none)');
  next();
});

// 認証チェック（セッション前提）
function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

router.use(requireLogin);

// 日本語 la_cf を英語キーへマッピングする関数（masters 用）
function mapCfToEnglish(cfRaw) {
  const cf = String(cfRaw || '').trim();
  if (cf === '収入項目') return 'income';
  if (cf === '控除項目') return 'deduction';
  if (cf === '貯蓄項目') return 'saving';
  return cf.toLowerCase();
}

// 英語/日本語 cf を日本語へ正規化する関数（保存・更新用）
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
    default: return ''; // 必要なら '支出' を既定にするなど
  }
}

/**
 * GET /api/finance/masters?group=GROUP_ID&year=YYYY
 * - budgets: Budget.find({ group, year }).sort({ display_order: 1 })
 * - items: Item.find({ group, year, la_cf/cf: 日本語/英語両対応 }) を英語キーへ正規化してグルーピング
 * - paymentItems: PaymentItem.find({ group, user: req.user._id, isLive: true }).sort({ display_order: 1 })
 * - members: User.find({ _id: { $in: group.members } }).select('username displayname').lean()
 */
router.get('/masters', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');

    const userIdRaw = req.user._id;
    const groupIdRaw = String(req.query.group || '').trim();
    const yearRaw = String(req.query.year || '').trim();

    if (!groupIdRaw || !yearRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group, year は必須です' });
    }

    const groupId = mongoose.Types.ObjectId.isValid(groupIdRaw) ? new mongoose.Types.ObjectId(groupIdRaw) : groupIdRaw;
    const userId = mongoose.Types.ObjectId.isValid(userIdRaw) ? new mongoose.Types.ObjectId(userIdRaw) : userIdRaw;

    const yearNum = parseInt(yearRaw, 10);
    const yearQuery = isNaN(yearNum) ? { year: yearRaw } : { $or: [{ year: yearRaw }, { year: yearNum }] };

    const group = await Group.findById(groupId).lean();
    if (!group) return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });

    const [budgetsDocs, itemsDocs, paymentDocs] = await Promise.all([
      Budget.find({ group: groupId, ...yearQuery }).sort({ display_order: 1, expense_item: 1 }).lean(),
      Item.find({
        group: groupId,
        ...yearQuery,
        $or: [
          { la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目'] } },
          { la_cf: { $in: ['income', 'deduction', 'saving'] } },
          { cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } }
        ]
      }).lean(),
      PaymentItem.find({ group: groupId, user: userId, isLive: true }).sort({ display_order: 1, paymentItem: 1 }).lean()
    ]);

    // budgets: expense_item -> item
    const budgets = budgetsDocs.map(doc => ({
      item: String(doc.expense_item ?? doc.item ?? ''),
      display_order: Number(doc.display_order ?? doc.displayOrder ?? 0),
      budget: Number(doc.budget ?? 0)
    }));

    // paymentItems: paymentItem -> item（重複排除）
    const paymentItemsRaw = paymentDocs.map(doc => ({
      item: String(doc.paymentItem ?? doc.item ?? ''),
      display_order: Number(doc.display_order ?? doc.displayOrder ?? 0)
    }));
    const paymentSeen = new Set();
    const paymentItems = [];
    for (const p of paymentItemsRaw) {
      if (!p.item) continue;
      if (paymentSeen.has(p.item)) continue;
      paymentSeen.add(p.item);
      paymentItems.push(p);
    }

    // items: la_cf 日本語→英語に正規化してグルーピング、重複排除
    const grouped = { income: [], deduction: [], saving: [] };
    const dupCheck = { income: new Set(), deduction: new Set(), saving: new Set() };

    for (const it of itemsDocs) {
      const cfKey = mapCfToEnglish(it.la_cf ?? it.cf);
      if (!grouped[cfKey]) continue;

      const masterItem = {
        item: String(it.item ?? it.name ?? ''),
        display_order: Number(it.display_order ?? it.displayOrder ?? 0)
      };
      if (!masterItem.item) continue;

      const uniqKey = `${masterItem.display_order}::${masterItem.item}`;
      if (dupCheck[cfKey].has(uniqKey)) continue;
      dupCheck[cfKey].add(uniqKey);

      grouped[cfKey].push(masterItem);
    }

    // 並び順
    for (const k of Object.keys(grouped)) {
      grouped[k].sort((a, b) => {
        if (a.display_order !== b.display_order) return a.display_order - b.display_order;
        return a.item.localeCompare(b.item, 'ja');
      });
    }

    // members
    const memberIds = Array.isArray(group.members) ? group.members : [];
    const membersDocs = await User.find({ _id: { $in: memberIds } })
      .select('username displayname')
      .lean();

    const members = membersDocs.map(u => ({
      id: String(u._id),
      username: u.username || '',
      displayname: u.displayname || null
    }));

    console.log('[masters] budgets:', budgets.length);
    console.log('[masters] items grouped:', {
      income: grouped.income.length,
      deduction: grouped.deduction.length,
      saving: grouped.saving.length
    });
    console.log('[masters] paymentItems:', paymentItems.length);

    res.json({ budgets, items: grouped, paymentItems, members });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance/recent?group=GROUP_ID&limit=20
 */
router.get('/recent', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const groupId = String(req.query.group || '').trim();
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    console.log('[api/finance] recent query:', { user: userId, group: groupId, limit });

    const query = { group: groupId };
    const items = await Finance.find(query)
      .sort({ date: -1, _id: -1 })
      .limit(limit)
      .lean();

    console.log('[api/finance] recent found:', items.length);

    const result = items.map(doc => {
      const category =
        doc.expense_item ||
        doc.income_item ||
        doc.saving_item ||
        doc.dedu_item ||
        doc.cf || '';
      return {
        id: String(doc._id),
        date: (doc.date instanceof Date ? doc.date : new Date(doc.date)).toISOString(),
        category,
        amount: Number(doc.amount || 0),
        memo: doc.memo || null,
        content: doc.content || null,
        cf: doc.cf || null,                 // ここは日本語が返る（保存時に正規化）
        paymentType: doc.payment_type || null,
        memberId: doc.member_id || (doc.user ? String(doc.user) : null)
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance?group=GROUP_ID
 * - 全件取得（検索用）
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const groupId = String(req.query.group || '').trim();

    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }

    console.log('[api/finance] all query:', { user: userId, group: groupId, scope: 'group' });

    const query = { user: userId, group: groupId };
    const items = await Finance.find(query)
      .sort({ date: -1, _id: -1 })
      .lean();

    console.log('[api/finance] all found:', items.length);

    const result = items.map(doc => {
      const category =
        doc.expense_item ||
        doc.income_item ||
        doc.saving_item ||
        doc.dedu_item ||
        doc.cf || '';
      return {
        id: String(doc._id),
        date: (doc.date instanceof Date ? doc.date : new Date(doc.date)).toISOString(),
        category,
        amount: Number(doc.amount || 0),
        memo: doc.memo || null,
        content: doc.content || null,
        cf: doc.cf || null,
        paymentType: doc.payment_type || null,
        memberId: doc.member_id || (doc.user ? String(doc.user) : null)
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance
 * - cf/item/payment_type/content/member_id を任意で受け付け
 * - payment_type が未指定でも必ず既定値('cash')を入れて required を満たす
 * - cf は英語/日本語どちらでも受け取り、日本語に正規化して保存
 */
router.post('/', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const {
      group,
      date,
      category,
      amount,
      memo,
      cf,           // 'expense' | 'income' | 'deduction' | 'saving' または 日本語 '支出' など
      paymentType,  // 支払種別
      memberId,     // 使用者ID
      content       // 内容（複数行）
    } = req.body || {};

    if (!group || !date || typeof amount !== 'number') {
      return res.status(400).json({ error: 'missing_fields', message: 'group, date, amount は必須です' });
    }

    const d = new Date(date);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'invalid_date', message: 'date の形式が不正です' });
    }

    // cf を日本語へ正規化（未指定時は '支出' を既定に）
    const cfKey = cfToJapanese(cf) || '支出';

    const doc = new Finance({
      user: userId,
      group,
      date: d,
      month: d.getMonth() + 1,
      day: d.getDate(),
      cf: cfKey,
      amount: Number(amount),
      memo: memo || null,
      payment_type: (typeof paymentType === 'string' && paymentType.trim().length > 0) ? paymentType.trim() : 'cash',
      member_id: (typeof memberId === 'string' && memberId.trim().length > 0) ? memberId.trim() : null,
      content: (typeof content === 'string' && content.trim().length > 0) ? content.trim() : null,
      entry_date: new Date()
    });

    // category の保存先を cf に応じて分岐（cfKey は日本語）
    if (typeof category === 'string' && category.trim().length > 0) {
      const cat = category.trim();
      switch (cfKey) {
        case '収入':
          doc.income_item = cat;
          break;
        case '貯蓄':
          doc.saving_item = cat;
          break;
        case '控除':
          doc.dedu_item = cat;
          break;
        case '支出':
        default:
          doc.expense_item = cat;
          break;
      }
    } else {
      if (cfKey === '支出') {
        doc.expense_item = '未分類';
      }
    }

    const saved = await doc.save();

    const resolvedCategory =
      (saved.cf === '収入' && saved.income_item) ||
      (saved.cf === '貯蓄' && saved.saving_item) ||
      (saved.cf === '控除' && saved.dedu_item) ||
      saved.expense_item ||
      saved.income_item ||
      saved.saving_item ||
      saved.dedu_item ||
      saved.cf || '';

    const result = {
      id: String(saved._id),
      date: saved.date.toISOString(),
      category: resolvedCategory,
      amount: Number(saved.amount || 0),
      memo: saved.memo || null,
      content: saved.content || null,
      cf: saved.cf || null,               // 日本語で返す
      paymentType: saved.payment_type || null,
      memberId: saved.member_id || null
    };

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/finance/:id
// - cf は英語/日本語どちらでも受け取り、日本語に正規化して保存
router.put('/:id', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const { id } = req.params;

    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid_id', message: 'ID が不正です' });
    }

    const existing = await Finance.findOne({ _id: id, user: userId }).lean();
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'データが見つかりません' });
    }

    const {
      date,
      category,
      amount,
      memo,
      cf,
      paymentType,
      memberId,
      content
    } = req.body || {};

    const update = {};

    if (date) {
      const d = new Date(date);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'invalid_date', message: 'date の形式が不正です' });
      }
      update.date = d;
      update.month = d.getMonth() + 1;
      update.day = d.getDate();
    }

    if (typeof amount === 'number' && Number.isFinite(amount)) {
      update.amount = Number(amount);
    }

    if (typeof memo !== 'undefined') {
      update.memo = memo || null;
    }

    if (typeof content !== 'undefined') {
      update.content = (typeof content === 'string' && content.trim().length > 0) ? content.trim() : null;
    }

    // cf を日本語へ正規化（指定があれば更新）
    if (typeof cf === 'string' && cf.trim().length > 0) {
      update.cf = cfToJapanese(cf) || existing.cf || '支出';
    }

    // category の保存先分岐（cf は日本語基準）
    const cfForCategory = update.cf || existing.cf || '支出';
    if (typeof category === 'string' && category.trim().length > 0) {
      const cat = category.trim();
      switch (cfForCategory) {
        case '収入':
          update.income_item = cat;
          break;
        case '貯蓄':
          update.saving_item = cat;
          break;
        case '控除':
          update.dedu_item = cat;
          break;
        case '支出':
        default:
          update.expense_item = cat;
          break;
      }
    }

    if (typeof paymentType !== 'undefined') {
      update.payment_type = (typeof paymentType === 'string' && paymentType.trim().length > 0)
        ? paymentType.trim()
        : null;
    }

    if (typeof memberId !== 'undefined') {
      update.member_id = (typeof memberId === 'string' && memberId.trim().length > 0)
        ? memberId.trim()
        : null;
    }

    update.update_date = new Date();
    const saved = await Finance.findByIdAndUpdate(id, update, { new: true }).lean();

    const resolvedCategory =
      (saved.cf === '収入' && saved.income_item) ||
      (saved.cf === '貯蓄' && saved.saving_item) ||
      (saved.cf === '控除' && saved.dedu_item) ||
      saved.expense_item ||
      saved.income_item ||
      saved.saving_item ||
      saved.dedu_item ||
      saved.cf || '';

    const result = {
      id: String(saved._id),
      date: (saved.date instanceof Date ? saved.date : new Date(saved.date)).toISOString(),
      category: resolvedCategory,
      amount: Number(saved.amount || 0),
      memo: saved.memo || null,
      content: saved.content || null,
      cf: saved.cf || null,               // 日本語で返す
      paymentType: saved.payment_type || null,
      memberId: saved.member_id || null
    };

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
