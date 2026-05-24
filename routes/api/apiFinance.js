// routes/api/apiFinance.js
const express = require('express');
const router = express.Router();
const Finance = require('../../models/finance');
const Budget = require('../../models/finance_ex_budget');      // 予算(支出)マスタ
const Item = require('../../models/finance_items');            // 収入/控除/貯蓄アイテム
const PaymentItem = require('../../models/paymentItems');      // 支払種別
const Group = require('../../models/groups');                  // グループ
const User = require('../../models/users');                    // ユーザー
const FinancePaymentTypeCheck = require('../../models/finance_payment_type_check');
const FinanceApiConfig = require('../../models/finance_api_config');
const jwt = require('jsonwebtoken');

// 共通ログ
router.use((req, res, next) => {
  next();
});

/**
 * GET /api/finance/config
 * - Finance APIの接続先URLを返す（認証不要）
 */
router.get('/config', async (req, res, next) => {
  try {
    const config = await FinanceApiConfig.findOne({}).sort({ updatedAt: -1 }).lean();
    const url = config?.url || 'https://www.allaboutme.jp';
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// 認証チェック（セッション or Bearer）
async function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
  }
}

router.use(requireLogin);

/**
 * POST /api/finance/config
 * - 管理者のみ更新可能
 */
router.post('/config', async (req, res, next) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'forbidden', message: '管理者のみ更新可能です' });
    }
    const url = String(req.body?.url || '').trim();
    if (!url) {
      return res.status(400).json({ error: 'missing_params', message: 'url は必須です' });
    }
    const normalized = url.endsWith('/') ? url.slice(0, -1) : url;

    const doc = await FinanceApiConfig.findOneAndUpdate(
      {},
      { url: normalized, updatedBy: req.user._id, updatedAt: new Date() },
      { new: true, upsert: true }
    ).lean();

    res.json({ ok: true, url: doc?.url || normalized });
  } catch (err) {
    next(err);
  }
});

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

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(tag => {
    const name = typeof tag?.name === 'string' ? tag.name.trim() : '';
    const category = typeof tag?.category === 'string' ? tag.category.trim() : '';
    const priceRaw = tag?.price;
    const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw);
    if (!name || !category || !Number.isFinite(price)) return null;
    return { name, category, price };
  }).filter(Boolean);
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

    res.json({ budgets, items: grouped, paymentItems, members });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance/payment-check?group=GROUP_ID&ym=YYYY-MM&paymentType=TYPE
 */
router.get('/payment-check', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.user._id;
    const groupIdRaw = String(req.query.group || '').trim();
    const ym = String(req.query.ym || '').trim();
    const paymentType = String(req.query.paymentType || '').trim();

    if (!groupIdRaw || !ym || !paymentType) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym, paymentType は必須です' });
    }

    const ymMatch = ym.match(/^(\d{4})-(\d{2})$/);
    if (!ymMatch) {
      return res.status(400).json({ error: 'invalid_ym', message: 'ym はYYYY-MM形式で指定してください' });
    }
    const year = Number(ymMatch[1]);
    const month = Number(ymMatch[2]) - 1;
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 1);

    const groupId = mongoose.Types.ObjectId.isValid(groupIdRaw) ? new mongoose.Types.ObjectId(groupIdRaw) : groupIdRaw;

    const group = await Group.findById(groupId).lean();
    if (!group) return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(userId))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const items = await Finance.find({
      user: userId,
      group: groupId,
      payment_type: paymentType,
      date: { $gte: start, $lt: end }
    })
      .sort({ date: 1, _id: 1 })
      .lean();

    const checkDoc = await FinancePaymentTypeCheck.findOne({
      user: userId,
      group: groupId,
      ym,
      paymentType
    }).lean();
    const checkedIds = (checkDoc?.checkedFinanceIds || []).map(id => String(id));

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
        cf: doc.cf || '',
        category,
        content: doc.content || doc.memo || '',
        amount: Number(doc.amount || 0),
        paymentType: doc.payment_type || ''
      };
    });

    res.json({ items: result, checkedIds });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/payment-check/toggle
 * body: { group, ym, paymentType, financeId, checked }
 */
router.post('/payment-check/toggle', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.user._id;
    const { group, ym, paymentType, financeId, checked } = req.body || {};

    const groupIdRaw = String(group || '').trim();
    const ymRaw = String(ym || '').trim();
    const paymentTypeRaw = String(paymentType || '').trim();
    const financeIdRaw = String(financeId || '').trim();

    if (!groupIdRaw || !ymRaw || !paymentTypeRaw || !financeIdRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group, ym, paymentType, financeId は必須です' });
    }

    const groupId = mongoose.Types.ObjectId.isValid(groupIdRaw) ? new mongoose.Types.ObjectId(groupIdRaw) : groupIdRaw;

    const groupDoc = await Group.findById(groupId).lean();
    if (!groupDoc) return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(userId))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const finId = mongoose.Types.ObjectId.isValid(financeIdRaw) ? new mongoose.Types.ObjectId(financeIdRaw) : financeIdRaw;
    const doCheck = checked === true;

    if (doCheck) {
      await FinancePaymentTypeCheck.findOneAndUpdate(
        { user: userId, group: groupId, ym: ymRaw, paymentType: paymentTypeRaw },
        { $addToSet: { checkedFinanceIds: finId } },
        { upsert: true, new: true }
      );
    } else {
      const updated = await FinancePaymentTypeCheck.findOneAndUpdate(
        { user: userId, group: groupId, ym: ymRaw, paymentType: paymentTypeRaw },
        { $pull: { checkedFinanceIds: finId } },
        { new: true }
      );
      if (updated && Array.isArray(updated.checkedFinanceIds) && updated.checkedFinanceIds.length === 0) {
        await FinancePaymentTypeCheck.deleteOne({ _id: updated._id });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance/budgets?group=GROUP_ID&year=YYYY
 * - expenseBudgets: finance_ex_budget for group+year
 * - otherBudgets: finance_items (income/deduction/saving) for group+year
 * - if none for year, fallback to previous year (per category)
 */
router.get('/budgets', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.user._id;
    const groupIdRaw = String(req.query.group || '').trim();
    const yearRaw = String(req.query.year || '').trim();

    if (!groupIdRaw || !yearRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group, year は必須です' });
    }

    const groupId = mongoose.Types.ObjectId.isValid(groupIdRaw) ? new mongoose.Types.ObjectId(groupIdRaw) : groupIdRaw;

    const group = await Group.findById(groupId).lean();
    if (!group) return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(userId))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const yearNum = parseInt(yearRaw, 10);
    const prevYear = isNaN(yearNum) ? '' : String(yearNum - 1);

    const expenseForYear = await Budget.find({ group: groupId, year: yearRaw })
      .sort({ display_order: 1, expense_item: 1 })
      .lean();
    const otherForYear = await Item.find({
      group: groupId,
      year: yearRaw,
      $or: [
        { la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } },
        { cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } }
      ]
    })
      .sort({ display_order: 1, item: 1 })
      .lean();

    let expenseSourceYear = yearRaw;
    let otherSourceYear = yearRaw;
    let expenseDocs = expenseForYear;
    let otherDocs = otherForYear;

    if (expenseDocs.length === 0 && prevYear) {
      const prev = await Budget.find({ group: groupId, year: prevYear })
        .sort({ display_order: 1, expense_item: 1 })
        .lean();
      if (prev.length > 0) {
        expenseDocs = prev;
        expenseSourceYear = prevYear;
      }
    }

    if (otherDocs.length === 0 && prevYear) {
      const prev = await Item.find({
        group: groupId,
        year: prevYear,
        $or: [
          { la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } },
          { cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } }
        ]
      })
        .sort({ display_order: 1, item: 1 })
        .lean();
      if (prev.length > 0) {
        otherDocs = prev;
        otherSourceYear = prevYear;
      }
    }

    const expenseBudgets = expenseDocs.map(doc => ({
      id: String(doc._id),
      item: String(doc.expense_item ?? ''),
      budget: Number(doc.budget ?? 0),
      display_order: Number(doc.display_order ?? 0)
    }));

    const otherBudgets = otherDocs.map(doc => ({
      id: String(doc._id),
      item: String(doc.item ?? ''),
      budget: Number(doc.budget ?? 0),
      display_order: Number(doc.display_order ?? 0),
      la_cf: String(doc.la_cf ?? doc.cf ?? '')
    }));

    res.json({
      year: yearRaw,
      expenseSourceYear,
      otherSourceYear,
      expenseBudgets,
      otherBudgets
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/finance/budgets
 * body: { group, year, expenseBudgets: [{ item, budget }], otherBudgets: [{ item, budget, la_cf }] }
 * - replace budgets for year (group)
 */
router.post('/budgets', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const userId = req.user._id;
    const { group, year, expenseBudgets, otherBudgets } = req.body || {};

    const groupIdRaw = String(group || '').trim();
    const yearRaw = String(year || '').trim();
    if (!groupIdRaw || !yearRaw) {
      return res.status(400).json({ error: 'missing_params', message: 'group, year は必須です' });
    }

    const groupId = mongoose.Types.ObjectId.isValid(groupIdRaw) ? new mongoose.Types.ObjectId(groupIdRaw) : groupIdRaw;
    const groupDoc = await Group.findById(groupId).lean();
    if (!groupDoc) return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(userId))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const expenseArray = Array.isArray(expenseBudgets) ? expenseBudgets : [];
    const otherArray = Array.isArray(otherBudgets) ? otherBudgets : [];

    await Budget.deleteMany({ group: groupId, year: yearRaw });
    await Item.deleteMany({ group: groupId, year: yearRaw, $or: [
      { la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } },
      { cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] } }
    ]});

    if (expenseArray.length > 0) {
      const docs = expenseArray.map((b, index) => ({
        display_order: Number(b.display_order ?? (index + 1)),
        year: yearRaw,
        expense_item: String(b.item ?? ''),
        budget: Number(b.budget ?? 0),
        group: groupId
      })).filter(d => d.expense_item);
      if (docs.length > 0) await Budget.insertMany(docs);
    }

    if (otherArray.length > 0) {
      const docs = otherArray.map((b, index) => ({
        display_order: Number(b.display_order ?? (index + 1)),
        la_cf: String(b.la_cf ?? ''),
        item: String(b.item ?? ''),
        year: yearRaw,
        budget: Number(b.budget ?? 0),
        group: groupId
      })).filter(d => d.item && d.la_cf);
      if (docs.length > 0) await Item.insertMany(docs);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/finance/grouped?date=YYYY-MM-DD
 * - 指定日のデータをグループ別に返す（API用）
 */
router.get('/grouped', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const dateRaw = String(req.query.date || '').trim();
    const match = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return res.status(400).json({ error: 'invalid_date', message: 'date はYYYY-MM-DD形式で指定してください' });
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    const items = await Finance.find({
      user: userId,
      $expr: {
        $let: {
          vars: {
            parts: {
              $dateToParts: {
                date: '$date',
                timezone: 'Asia/Tokyo'
              }
            }
          },
          in: {
            $and: [
              { $eq: ['$$parts.year', year] },
              { $eq: ['$$parts.month', month] },
              { $eq: ['$$parts.day', day] }
            ]
          }
        }
      }
    })
      .sort({ date: -1, _id: -1 })
      .populate('group', 'group_name')
      .lean();

    const groupedMap = new Map();
    for (const item of items) {
      const group = item.group && typeof item.group === 'object' ? item.group : null;
      const groupId = group && group._id ? String(group._id) : 'unknown';
      const groupName = group && group.group_name ? String(group.group_name) : 'Group';

      if (!groupedMap.has(groupId)) {
        groupedMap.set(groupId, { group: { _id: groupId, name: groupName }, items: [] });
      }

      groupedMap.get(groupId).items.push({
        _id: String(item._id),
        date: (item.date instanceof Date ? item.date : new Date(item.date)).toISOString(),
        cf: item.cf || '',
        income_item: item.income_item || null,
        expense_item: item.expense_item || null,
        dedu_item: item.dedu_item || null,
        saving_item: item.saving_item || null,
        content: item.content || null,
        amount: Number(item.amount || 0),
        payment_type: item.payment_type || '',
        memo: item.memo || null,
        tags: Array.isArray(item.tags) ? item.tags : []
      });
    }

    res.json({
      date: dateRaw,
      groups: Array.from(groupedMap.values())
    });
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

    const query = { user: userId, group: groupId };
    const items = await Finance.find(query)
      .sort({ date: -1, _id: -1 })
      .limit(limit)
      .lean();

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
        subTag: doc.sub_tag || null,
        cf: doc.cf || null,                 // ここは日本語が返る（保存時に正規化）
        paymentType: doc.payment_type || null,
        memberId: doc.member_id || (doc.user ? String(doc.user) : null),
        tags: Array.isArray(doc.tags) ? doc.tags : []
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
router.get('/sub-tags', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const groupId = String(req.query.group || '').trim();
    const category = String(req.query.category || '').trim();
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 8));

    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }

    const normalizedGroupId = mongoose.Types.ObjectId.isValid(groupId)
      ? new mongoose.Types.ObjectId(groupId)
      : groupId;

    const match = {
      group: normalizedGroupId,
      cf: '支出',
      sub_tag: { $exists: true, $type: 'string', $ne: '' }
    };
    if (category) {
      match.expense_item = category;
    }

    const items = await Finance.aggregate([
      { $match: match },
      { $group: { _id: '$sub_tag', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: limit }
    ]);

    res.json({
      items: items
        .map(item => String(item._id || '').trim())
        .filter(Boolean)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const groupId = String(req.query.group || '').trim();

    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }

    const query = { group: groupId };
    const items = await Finance.find(query)
      .sort({ date: -1, _id: -1 })
      .lean();

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
        subTag: doc.sub_tag || null,
        cf: doc.cf || null,
        paymentType: doc.payment_type || null,
        memberId: doc.member_id || (doc.user ? String(doc.user) : null),
        tags: Array.isArray(doc.tags) ? doc.tags : []
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
      payment_type,
      memberId,     // 使用者ID
      member_id,
      content,      // 内容（複数行）
      sub_tag,      // サブタグ（任意）
      tags          // レシート明細（任意）
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
    const paymentTypeValue = typeof paymentType !== 'undefined' ? paymentType : payment_type;
    const memberIdValue = typeof memberId !== 'undefined' ? memberId : member_id;

    const doc = new Finance({
      user: userId,
      group,
      date: d,
      month: d.getMonth() + 1,
      day: d.getDate(),
      cf: cfKey,
      amount: Number(amount),
      memo: memo || null,
      payment_type: (typeof paymentTypeValue === 'string' && paymentTypeValue.trim().length > 0) ? paymentTypeValue.trim() : 'cash',
      member_id: (typeof memberIdValue === 'string' && memberIdValue.trim().length > 0) ? memberIdValue.trim() : null,
      content: (typeof content === 'string' && content.trim().length > 0) ? content.trim() : null,
      sub_tag: (typeof sub_tag === 'string' && sub_tag.trim().length > 0) ? sub_tag.trim() : null,
      entry_date: new Date()
    });
    if (cfKey === '支出') {
      const normalizedTags = normalizeTags(tags);
      if (normalizedTags.length > 0) {
        doc.tags = normalizedTags;
      }
    }

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
      subTag: saved.sub_tag || null,
      cf: saved.cf || null,               // 日本語で返す
      paymentType: saved.payment_type || null,
      memberId: saved.member_id || null,
      tags: Array.isArray(saved.tags) ? saved.tags : []
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
      payment_type,
      memberId,
      member_id,
      content,
      sub_tag,
      group,
      tags
    } = req.body || {};

    const update = {};

    if (typeof group === 'string' && group.trim().length > 0) {
      const groupIdRaw = group.trim();
      if (!mongoose.Types.ObjectId.isValid(groupIdRaw)) {
        return res.status(400).json({ error: 'invalid_group', message: 'group が不正です' });
      }
      const groupId = new mongoose.Types.ObjectId(groupIdRaw);
      const groupDoc = await Group.findById(groupId).select('members').lean();
      if (!groupDoc) {
        return res.status(404).json({ error: 'group_not_found', message: 'グループが見つかりません' });
      }
      const members = Array.isArray(groupDoc.members) ? groupDoc.members.map(m => String(m)) : [];
      if (!members.includes(String(userId))) {
        return res.status(403).json({ error: 'forbidden', message: 'このグループを操作する権限がありません' });
      }
      update.group = groupId;
    }

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

    if (typeof sub_tag !== 'undefined') {
      update.sub_tag = (typeof sub_tag === 'string' && sub_tag.trim().length > 0) ? sub_tag.trim() : null;
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

    if (cfForCategory !== '支出') {
      update.tags = [];
    }
    if (typeof tags !== 'undefined') {
      update.tags = cfForCategory === '支出' ? normalizeTags(tags) : [];
    }

    const paymentTypeValue = typeof paymentType !== 'undefined' ? paymentType : payment_type;
    if (typeof paymentTypeValue !== 'undefined') {
      update.payment_type = (typeof paymentTypeValue === 'string' && paymentTypeValue.trim().length > 0)
        ? paymentTypeValue.trim()
        : null;
    }

    const memberIdValue = typeof memberId !== 'undefined' ? memberId : member_id;
    if (typeof memberIdValue !== 'undefined') {
      update.member_id = (typeof memberIdValue === 'string' && memberIdValue.trim().length > 0)
        ? memberIdValue.trim()
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
      subTag: saved.sub_tag || null,
      cf: saved.cf || null,               // 日本語で返す
      paymentType: saved.payment_type || null,
      memberId: saved.member_id || null,
      tags: Array.isArray(saved.tags) ? saved.tags : []
    };

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/finance/:id
router.delete('/:id', async (req, res, next) => {
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

    await Finance.deleteOne({ _id: id, user: userId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
