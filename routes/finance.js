const express = require('express');
const router = express.Router();
const catchAsync = require('../Utils/catchAsync');
const ExpressError = require('../Utils/ExpressError');
const Finance = require('../models/finance');
const OCRLog = require('../models/ocrs');
const { financeSchema } = require('../schemas');
const mongoose = require('mongoose');
const methodOverride = require('method-override');
const FinanceUser = require('../models/users');
const Budget = require('../models/finance_ex_budget');
const Items = require('../models/finance_items');
const PersonalBudget = require('../models/finance_ex_budget_personal');
const PersonalItem = require('../models/finance_items_personal');
const PaymentItem = require('../models/paymentItems');
const { correctOcrText } = require('../Utils/gptCorrection');
const { convertHeicToJpeg } = require('../Utils/imageUtils');
const cron = require('node-cron');
const Group = require('../models/groups');
const FinanceBudgetNotice = require('../models/finance_budget_notice');
const { sendMail } = require('../Utils/mailer');
const MatometeSetting = require('../models/matomete_setting');
const FinanceBudgetNoticeSetting = require('../models/finance_budget_notice_setting');
const FinanceItemCategoryGroup = require('../models/finance_item_category_group');
const FinanceCloseStatus = require('../models/finance_close_status');
const FinanceCloseGroup = require('../models/finance_close_group');
const FinanceCloseYearStatus = require('../models/finance_close_year_status');
const FinanceCloseYearGroup = require('../models/finance_close_year_group');
const {
  normalizeFiscalStartMonth,
  getFiscalYearForDate,
  getPreviousFiscalYearMeta,
  getFiscalYearStartDateInCalendarYear
} = require('../Utils/fiscalYear');
const {
  FINANCE_QUICK_MENU_ITEMS,
  normalizeQuickMenuItems,
  buildQuickMenuItems
} = require('../Utils/financeQuickMenu');
const { fetchPublishedInfosForGroup } = require('../Utils/infoDelivery');

// 必要なモジュール
const multer = require('multer');

//レシートの画像を保管する
const path = require('path');
// レシートの画像を保管する
const upload = multer({
  dest: path.join(__dirname, '../public/uploads/receipts'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic|heif)$/i.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error('許可されていないファイル種別です'));
  }
});
let visionClient;
function getVisionClient() {
  if (visionClient) return visionClient;
  const vision = require('@google-cloud/vision');
  visionClient = new vision.ImageAnnotatorClient();
  return visionClient;
}
const fs = require('fs');
const pathLib = require('path');


const { isLoggedIn, logAction } = require('../middleware');
const sanitizeReturnPath = (value, fallback = '') => {
  const path = String(value || '').trim();
  if (!path) return fallback;
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
};
const getListRedirect = (req) => sanitizeReturnPath(req.session?.financeListReturn, '/finance/list');
const getPreviousMonthMeta = (baseDate = new Date()) => {
  const target = new Date(baseDate.getFullYear(), baseDate.getMonth() - 1, 1);
  const monthKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = `${target.getFullYear()}年${target.getMonth() + 1}月度`;
  const start = new Date(target.getFullYear(), target.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999);
  return { monthKey, monthLabel, start, end, year: String(target.getFullYear()) };
};
const getPreviousYearMeta = (baseDate = new Date(), startMonth = 1) => {
  return getPreviousFiscalYearMeta(baseDate, startMonth);
};
const isGroupServiceEnabled = (user, groupId, serviceKey) => {
  if (!user) return false;
  const gid = groupId ? groupId.toString() : null;
  if (gid && user.servicesByGroup) {
    const map = user.servicesByGroup;
    const groupServices = typeof map.get === 'function' ? map.get(gid) : map[gid];
    if (groupServices && typeof groupServices[serviceKey] === 'boolean') {
      return groupServices[serviceKey];
    }
  }
  return true;
};

//selectedの選択肢をここで定義
const la_cfs = ['Please Choice','支出','収入','控除','貯蓄'];
const defaultInItems = ['Please Choice','給与','賞与','その他'];
const defaultDeduCfs = ['Please Choice','所得税','住民税','健康保険料','厚生年金保険料','介護保険','雇用保険','その他控除'];
const defaultSavingCfs = ['Please Choice', '貯金', '生命保険', 'その他貯金'];
let in_items = [...defaultInItems];
let dedu_cfs = [...defaultDeduCfs];
let saving_cfs = [...defaultSavingCfs];
const ex_cfs = [
      '副食物費','主食費1','主食費2','調味料','光熱費','住宅・家具費',
      '衣服費','教育費','交際費','教養費','娯楽費','保険・衛生費',
      '職業費','特別費','公共費','車関連費','通信費','外税'
    ];
//const pay_cfs = []; // PaymentItemから取得に変更
const whos = []; //activeGrouopIdから読み込む

const getCurrentFiscalYear = (startMonth = 1) => {
  return getFiscalYearForDate(new Date(), startMonth) ?? new Date().getFullYear();
};

const getGroupFiscalStartMonth = async (groupId) => {
  if (!groupId) return 1;
  const group = await Group.findById(groupId).select('financeFiscalStartMonth');
  return normalizeFiscalStartMonth(group?.financeFiscalStartMonth);
};

const parseDateValue = (value) => {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
};

const resolveFiscalYearForValue = (value, startMonth = 1) => {
  const dt = parseDateValue(value);
  if (dt) {
    return getFiscalYearForDate(dt, startMonth) ?? dt.getFullYear();
  }
  return getCurrentFiscalYear(startMonth);
};

// Financeトップ
router.get('/top', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/login');
    }

    const objectId = typeof activeGroupId === 'string'
      ? new mongoose.Types.ObjectId(activeGroupId)
      : activeGroupId;

    const today = new Date();
    const fiscalStartMonth = await getGroupFiscalStartMonth(objectId);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const monthStartStr = monthStart.toISOString().split('T')[0];
    const monthEndStr = monthEnd.toISOString().split('T')[0];
    const daysInMonth = monthEnd.getDate();
    const dayRate = Math.round((today.getDate() / daysInMonth) * 1000) / 10;
    const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];
    const prevDayCount = Math.max(today.getDate() - 1, 0);
    const dayRatePrev = Math.round((prevDayCount / daysInMonth) * 1000) / 10;
    const todayMeta = {
      year: today.getFullYear(),
      month: today.getMonth() + 1,
      day: today.getDate(),
      weekday: weekdayLabels[today.getDay()],
      dayRate,
      dayRatePrev
    };
    const fiscalYear = getFiscalYearForDate(today, fiscalStartMonth) ?? today.getFullYear();
    const yearStr = String(fiscalYear);
    const infos = await fetchPublishedInfosForGroup(objectId, today);

    const budgets = await Budget.find({ group: objectId, year: yearStr }).sort({ display_order: 1 }).lean();
    const budgetMap = new Map(budgets.map(b => [b.expense_item || '未分類', Number(b.budget) || 0]));
    const totalBudget = Array.from(budgetMap.values()).reduce((sum, v) => sum + v, 0);

    const expenseAgg = await Finance.aggregate([
      {
        $match: {
          group: objectId,
          cf: '支出',
          date: { $gte: monthStart, $lte: monthEnd }
        }
      },
      { $group: { _id: '$expense_item', total: { $sum: '$amount' } } }
    ]);
    const actualMap = new Map(expenseAgg.map(r => [r._id || '未分類', Number(r.total) || 0]));
    const totalActual = Array.from(actualMap.values()).reduce((sum, v) => sum + v, 0);
    const totalRate = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 1000) / 10 : 0;

    const budgetItems = budgets.map(b => {
      const name = b.expense_item || '未分類';
      const budget = Number(b.budget) || 0;
      const actual = actualMap.get(name) || 0;
      const rate = budget > 0 ? Math.round((actual / budget) * 1000) / 10 : 0;
      return {
        name,
        budget,
        actual,
        rate,
        over: rate > dayRate
      };
    }).sort((a, b) => {
      if (a.over === b.over) return b.rate - a.rate;
      return a.over ? -1 : 1;
    });

    const recentFinances = await Finance.find({
      group: objectId,
      user: req.user._id
    })
      .sort({ date: -1, entry_date: -1 })
      .limit(5)
      .populate('user');

    const { monthKey: closeMonthKey, monthLabel: closeMonthLabel } = getPreviousMonthMeta(today);
    const closeGroup = await Group.findById(objectId).populate('members').populate('createdBy');
    const closeNormalizeId = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (value._id) return value._id.toString();
      return null;
    };
    const closeMemberMap = new Map();
    (closeGroup?.members || []).forEach((member) => {
      if (!isGroupServiceEnabled(member, objectId, 'finance')) return;
      const id = closeNormalizeId(member);
      if (!id) return;
      closeMemberMap.set(id, {
        id,
        name: member.displayname || member.username || '未設定'
      });
    });
    if (isGroupServiceEnabled(closeGroup?.createdBy, objectId, 'finance')) {
      const id = closeNormalizeId(closeGroup.createdBy);
      if (id && !closeMemberMap.has(id)) {
        closeMemberMap.set(id, {
          id,
          name: closeGroup.createdBy.displayname || closeGroup.createdBy.username || '未設定'
        });
      }
    }
    const closeMemberIds = Array.from(closeMemberMap.keys())
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    const closeStatuses = closeMemberIds.length > 0
      ? await FinanceCloseStatus.find({
        group: objectId,
        month: closeMonthKey,
        user: { $in: closeMemberIds }
      }).lean()
      : [];
    const closeStatusMap = new Map(
      closeStatuses.map(s => [s.user.toString(), s.completed === true])
    );
    const closeMembers = Array.from(closeMemberMap.values()).map(m => ({
      id: m.id,
      name: m.name,
      completed: closeStatusMap.get(m.id) === true,
      isSelf: req.user && m.id === req.user._id.toString()
    }));

    const { year: closeYearValue, yearLabel: closeYearLabel, start: closeYearStart, end: closeYearEnd } = getPreviousFiscalYearMeta(today, fiscalStartMonth);
    const yearStatuses = closeMemberIds.length > 0
      ? await FinanceCloseYearStatus.find({
        group: objectId,
        year: closeYearValue,
        user: { $in: closeMemberIds }
      }).lean()
      : [];
    const yearStatusMap = new Map(
      yearStatuses.map(s => [s.user.toString(), s.completed === true])
    );
    const closeYearMembers = Array.from(closeMemberMap.values()).map(m => ({
      id: m.id,
      name: m.name,
      completed: yearStatusMap.get(m.id) === true,
      isSelf: req.user && m.id === req.user._id.toString()
    }));

    const AssetInventory = require('../models/assetInventory');
    const latestInventory = await AssetInventory.findOne({ group: objectId }).sort({ inventoryMonth: -1 });
    let totalYen = 0;
    let totalByCf = { '金融資産': 0, '実物資産': 0, '無形資産': 0, '負債': 0 };
    let inventoryLabel = '未登録';

    if (latestInventory) {
      totalYen = latestInventory.totalYen || 0;
      const invTotals =
        latestInventory.totalByCf instanceof Map
          ? Object.fromEntries(latestInventory.totalByCf)
          : latestInventory.totalByCf || {};
      Object.keys(totalByCf).forEach((key) => {
        totalByCf[key] = invTotals[key] || 0;
      });
      const invDate = latestInventory.inventoryMonth;
      if (invDate) {
        inventoryLabel = `${invDate.getFullYear()}年${String(invDate.getMonth() + 1).padStart(2, '0')}月`;
      }
    }

    res.render('finance/top', {
      budgetSummary: {
        totalBudget,
        totalActual,
        totalRate,
        dayRate,
        items: budgetItems
      },
      budgetMonthRange: {
        start: monthStartStr,
        end: monthEndStr
      },
      closeStatus: {
        monthLabel: closeMonthLabel,
        members: closeMembers
      },
      closeYearStatus: {
        yearLabel: closeYearLabel,
        yearValue: closeYearValue,
        members: closeYearMembers
      },
      fiscalStartMonth,
      todayMeta,
      infos,
      recentFinances,
      totalYen,
      totalByCf,
      inventoryLabel
    });
  } catch (error) {
    console.error('Financeトップ取得エラー:', error);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

function extractYearFromDate(dateValue) {
  if (!dateValue) return null;
  const dt = new Date(dateValue);
  if (Number.isNaN(dt.getTime())) return null;
  return String(dt.getFullYear());
}

async function fetchItemsByYear(groupId, laCf, year) {
  const yearStr = year ? String(year) : null;
  let items = [];
  if (yearStr) {
    items = await Items.find({ group: groupId, la_cf: laCf, year: yearStr }).sort({ display_order: 1 });
  }
  if (items.length === 0) {
    items = await Items.find({ group: groupId, la_cf: laCf, year: { $exists: false } }).sort({ display_order: 1 });
  }
  return items;
}

async function fetchExpenseItemsByYear(groupId, year, startMonth = 1) {
  const yearStr = year ? String(year) : String(getCurrentFiscalYear(startMonth));
  const budgetItems = await Budget.find({ group: groupId, year: yearStr }).sort({ display_order: 1 });
  if (budgetItems.length === 0) {
    return ['Please Choice', ...ex_cfs];
  }
  return ['Please Choice', ...budgetItems.map(item => item.expense_item)];
}

async function loadCfItems(req, year, startMonth = 1) {
  const groupId = req.session.activeGroupId;
  const targetYear = year ? String(year) : String(getCurrentFiscalYear(startMonth));
  in_items = [...defaultInItems];
  dedu_cfs = [...defaultDeduCfs];
  saving_cfs = [...defaultSavingCfs];
  const incomeItems = await fetchItemsByYear(groupId, '収入項目', targetYear);
  if (incomeItems.length > 0) {
    in_items = ['Please Choice', ...incomeItems.map(i => i.item)];
  }

  const deductionItems = await fetchItemsByYear(groupId, '控除項目', targetYear);
  if (deductionItems.length > 0) {
    dedu_cfs = ['Please Choice', ...deductionItems.map(i => i.item)];
  }

  const savingItems = await fetchItemsByYear(groupId, '貯蓄項目', targetYear);
  if (savingItems.length > 0) {
    saving_cfs = ['Please Choice', ...savingItems.map(i => i.item)];
  }

  // 支払方法(pay_cfs)をDB(PaymentItem)から取得（ログインユーザーのみに絞る）
  const payItems = await PaymentItem.find({ group: groupId, user: req.user._id }).sort({ display_order: 1 });
  global.pay_cfs = ['Please Choice', ...payItems.map(p => p.paymentItem)];
  return { in_items, dedu_cfs, saving_cfs };
}

const normalizeIdString = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  return value.toString();
};

const appendMissingOption = (options = [], value) => {
  if (!value) return options;
  return options.includes(value) ? options : [...options, value];
};

const serializeFinanceUsers = (users = []) => users.map((user) => ({
  id: normalizeIdString(user._id),
  name: user.displayname || user.username || '未設定'
}));

const extractTagsFromRequest = (tagItemsInput) => {
  if (!tagItemsInput) return [];
  const tagSource = Array.isArray(tagItemsInput)
    ? tagItemsInput
    : Object.values(tagItemsInput);
  return tagSource
    .filter(item => item && item.name)
    .map(item => ({
      name: item.name,
      category: item.category || '',
      price: Number(item.price) || 0
    }));
};

const normalizeSubTag = (value) => (typeof value === 'string' ? value.trim() : '');

const getFrequentFinanceTags = async (groupId, userId = null) => {
  if (!groupId) return [];
  let hiddenTagNames = new Set();
  if (userId) {
    const user = await FinanceUser.findById(userId).select('financeHiddenCommonTags').lean();
    hiddenTagNames = new Set(
      (user?.financeHiddenCommonTags || [])
        .filter(item => normalizeIdString(item?.group) === normalizeIdString(groupId))
        .map(item => normalizeSubTag(item?.name))
        .filter(Boolean)
    );
  }
  const rows = await Finance.aggregate([
    {
      $match: {
        group: new mongoose.Types.ObjectId(groupId),
        sub_tag: { $exists: true, $nin: ['', null] }
      }
    },
    {
      $group: {
        _id: {
          category: '$expense_item',
          tag: '$sub_tag'
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1, '_id.tag': 1 } }
  ]);

  const grouped = new Map();
  rows.forEach((row) => {
    const tag = normalizeSubTag(row?._id?.tag);
    if (!tag) return;
    if (hiddenTagNames.has(tag)) return;
    const category = row?._id?.category || '';
    if (!grouped.has(category)) grouped.set(category, []);
    const tags = grouped.get(category);
    if (tags.length < 12 && !tags.some(item => item.name === tag)) {
      tags.push({ name: tag, count: row.count || 0 });
    }
  });

  return Array.from(grouped.entries()).map(([category, tags]) => ({ category, tags }));
};

async function getFinanceEditableGroupsForUser(userId) {
  const currentUser = await FinanceUser.findById(userId).populate('groups');
  const availableGroups = Array.isArray(currentUser?.groups)
    ? currentUser.groups.filter(group => isGroupServiceEnabled(currentUser, group._id, 'finance'))
    : [];
  const availableGroupIds = new Set(availableGroups.map(group => normalizeIdString(group._id)));
  return { currentUser, availableGroups, availableGroupIds };
}

async function buildFinanceFormOptions({ groupId, year, preserveValues = null, userId = null }) {
  const exExpenseItems = await fetchExpenseItemsByYear(groupId, year);
  const incomeItems = await fetchItemsByYear(groupId, '収入項目', year);
  const deductionItems = await fetchItemsByYear(groupId, '控除項目', year);
  const savingItems = await fetchItemsByYear(groupId, '貯蓄項目', year);

  let inItems = incomeItems.length > 0
    ? ['Please Choice', ...incomeItems.map(i => i.item)]
    : [...defaultInItems];
  let deduItems = deductionItems.length > 0
    ? ['Please Choice', ...deductionItems.map(i => i.item)]
    : [...defaultDeduCfs];
  let savingCfs = savingItems.length > 0
    ? ['Please Choice', ...savingItems.map(i => i.item)]
    : [...defaultSavingCfs];

  let exCfs = [...exExpenseItems];
  if (preserveValues) {
    exCfs = appendMissingOption(exCfs, preserveValues.expense_item);
    inItems = appendMissingOption(inItems, preserveValues.income_item);
    deduItems = appendMissingOption(deduItems, preserveValues.dedu_item);
    savingCfs = appendMissingOption(savingCfs, preserveValues.saving_item);
  }

  let allUsers = await FinanceUser.find({ groups: groupId })
    .select('displayname username servicesByGroup')
    .sort({ displayname: 1, username: 1 });
  allUsers = allUsers.filter(user => isGroupServiceEnabled(user, groupId, 'finance'));

  const memberIds = allUsers
    .map(user => user._id)
    .filter(Boolean);
  const rawPayItems = memberIds.length > 0
    ? await PaymentItem.find({ group: groupId, user: { $in: memberIds } })
      .sort({ display_order: 1, paymentItem: 1 })
    : [];
  const seenPayItems = new Set();
  let payCfs = ['Please Choice'];
  rawPayItems.forEach((item) => {
    if (!item?.paymentItem || seenPayItems.has(item.paymentItem)) return;
    seenPayItems.add(item.paymentItem);
    payCfs.push(item.paymentItem);
  });

  if (preserveValues?.payment_type) {
    payCfs = appendMissingOption(payCfs, preserveValues.payment_type);
  }
  if (preserveValues?.userId) {
    const selectedUserId = normalizeIdString(preserveValues.userId);
    const hasSelectedUser = allUsers.some(user => normalizeIdString(user._id) === selectedUserId);
    if (!hasSelectedUser && mongoose.Types.ObjectId.isValid(selectedUserId)) {
      const selectedUser = await FinanceUser.findById(selectedUserId).select('displayname username servicesByGroup');
      if (selectedUser) {
        allUsers.push(selectedUser);
      }
    }
  }

  return {
    ex_cfs: exCfs,
    in_items: inItems,
    dedu_cfs: deduItems,
    saving_cfs: savingCfs,
    pay_cfs: payCfs,
    allUsers,
    common_tags: await getFrequentFinanceTags(groupId, userId)
  };
}

function formatDuplicateMessage(entry) {
  const formatDate = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toISOString().split('T')[0];
  };
  const cf = entry?.cf || '';
  const category = cf === '支出'
    ? entry?.expense_item || ''
    : cf === '収入'
      ? entry?.income_item || ''
      : cf === '控除'
        ? entry?.dedu_item || ''
        : cf === '貯蓄'
          ? entry?.saving_item || ''
          : '';
  const content = entry?.content || '';
  const asNumber = Number(entry?.amount);
  const amountStr = Number.isFinite(asNumber)
    ? asNumber.toLocaleString('ja-JP')
    : (entry?.amount || '');
  const payment = entry?.payment_type || '';

  return `年月日: ${formatDate(entry?.date)}、収支区分: ${cf || '未指定'}、区分: ${category || '未指定'}、内容: ${content || '未入力'}、金額: ${amountStr}円、支払種別: ${payment || '未指定'}の登録が完了して、複製しました。次のレシートを入力してください！`;
}


//ミドルウェア部分はschema定義を切り出したので、、、
const validatefinance = (req, res, next) => {
    const { error } = financeSchema.validate(req.body.finance, { allowUnknown: true });
    if (error) {
        const msg = error.details.map(detail => detail.message).join(',');
        throw new ExpressError(msg, 400);
    } else {
        //これが無いと正常なときに動作がここで止まるのでnextに処理を渡す用にする
        next();
    }
};

const resolveItemKeyForDuplicate = (financeData) => {
    switch (financeData?.cf) {
        case '支出':
            return 'expense_item';
        case '収入':
            return 'income_item';
        case '控除':
            return 'dedu_item';
        case '貯蓄':
            return 'saving_item';
        default:
            return null;
    }
};

const buildDuplicateQuery = (financeData) => {
    const dateObj = new Date(financeData.date);
    const startOfDay = new Date(dateObj);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(dateObj);
    endOfDay.setHours(23, 59, 59, 999);

    const itemKey = resolveItemKeyForDuplicate(financeData);
    const itemValue = itemKey ? (financeData[itemKey] || '') : '';

    const userId = financeData.user?._id || financeData.user;
    const groupId = financeData.group?._id || financeData.group;

    const query = {
        user: userId,
        group: groupId,
        date: { $gte: startOfDay, $lte: endOfDay },
        cf: financeData.cf,
        amount: Number(financeData.amount),
        payment_type: financeData.payment_type
    };
    if (itemKey && itemValue) {
        query[itemKey] = itemValue;
    }
    return query;
};

//formのリクエストが来たときにパースしてreq.bodyに入れてくれる
router.use(express.urlencoded({ extended: true }));
router.use(methodOverride('_method'));
router.use((req, res, next) => {
  res.locals.financeTagRegistrationEnabled = req.user?.financeTagRegistrationEnabled === true;
  next();
});

//新規登録　表示用
router.get('/entry', isLoggedIn, async(req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }
    const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
    const yearForItems = resolveFiscalYearForValue(req.query?.date, fiscalStartMonth);
    await loadCfItems(req, yearForItems, fiscalStartMonth);
    // MongoDBからデータを取得（activeGroupIDで絞り込み）
    const allUsers = await FinanceUser.find({ groups: activeGroupId });
    const ex_cfs = await fetchExpenseItemsByYear(activeGroupId, yearForItems);
    const common_tags = await getFrequentFinanceTags(activeGroupId, req.user?._id);
    const financeTagRegistrationEnabled = req.user?.financeTagRegistrationEnabled === true;

    res.render('finance/entry', {
        page: 'entry',
        la_cfs,
        ex_cfs,
        in_items,
        dedu_cfs,
        saving_cfs,
        pay_cfs: global.pay_cfs,
        whos,
        allUsers,
        formData: {},   // 初期値として空のオブジェクトを渡す
        errors: {},     // 初期値として空のオブジェクトを渡す
        duplicateWarning: false,
        common_tags,
        financeTagRegistrationEnabled
    });
});

//新規でデータを登録する
router.post('/entry', upload.single('receiptImage'), catchAsync(async (req, res, next) => {
    // レシート画像のパスをログ出力
    if (req.file) {
      // console.log('アップロードされたレシート画像パス:', req.file.path);
    }
    const activeGroupId = req.session.activeGroupId;
    const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
    const yearForItems = resolveFiscalYearForValue(req.body?.finance?.date, fiscalStartMonth);
    await loadCfItems(req, yearForItems, fiscalStartMonth);
    const { finance } = req.body;
    const nextAction = Array.isArray(req.body.nextAction) ? req.body.nextAction[0] : req.body.nextAction;
    const allUsers = await FinanceUser.find({ groups: req.session.activeGroupId });
    const common_tags = await getFrequentFinanceTags(activeGroupId, req.user?._id);
    const financeTagRegistrationEnabled = req.user?.financeTagRegistrationEnabled === true;
    let errors = {};

    let extractedAmount = null;

    if (!finance) {
        req.flash('error', 'フォームデータが送信されていません');
        return res.redirect('/finance/entry');
    }

    const { date, cf, amount, payment_type, user } = finance;
    const ex_cfs = await fetchExpenseItemsByYear(activeGroupId, yearForItems);

    if (!date) errors.date = "日付は必須です";
    if (!cf || cf === 'Please Choice') errors.cf = "収支区分は必須です。まだ登録は完了していません。";
    if (cf === '支出' && (!finance.expense_item || finance.expense_item === 'Please Choice')) {
        errors.expense_item = "支出区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '収入' && (!finance.income_item || finance.income_item === 'Please Choice')) {
        errors.income_item = "収入区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '控除' && (!finance.dedu_item || finance.dedu_item === 'Please Choice')) {
        errors.dedu_item = "控除区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '貯蓄' && (!finance.saving_item || finance.saving_item === 'Please Choice')) {
        errors.saving_item = "貯蓄区分は必須です。まだ登録は完了していません。";
    }
    // 金額未入力の場合、OCRで抽出した金額があればそちらを利用
    if ((!amount || amount === '') && !extractedAmount) errors.amount = "金額は必須です";
    if (!payment_type || payment_type === 'Please Choice') errors.payment_type = "支払種別は必須です、まだ登録は完了してません。";
    if (!user || user === 'Please Choice') errors.user = "対象者は必須です";

    if (Object.keys(errors).length > 0) {
        // Ensure tags is always array of objects with name property
        let formData = req.body;
        if (formData?.tags && Array.isArray(formData.tags)) {
          formData.tags = formData.tags.map(tag => (typeof tag === 'string' ? { name: tag } : tag));
        }
        // Also handle finance[tags] (from nested form) if present
        if (formData?.['finance[tags]'] && Array.isArray(formData['finance[tags]'])) {
          formData.tags = formData['finance[tags]'].map(tag => (typeof tag === 'string' ? { name: tag } : tag));
        }
        return res.render('finance/entry', {
            page: 'entry',
            errors,
            formData,
            la_cfs,
            ex_cfs,
            in_items,
            dedu_cfs,
            saving_cfs,
            pay_cfs: global.pay_cfs,
            whos,
            allUsers,
            ocrAmount: extractedAmount || '',
            duplicateWarning: false,
            common_tags,
            financeTagRegistrationEnabled
        });
    }

    if (!finance) {
        req.flash('error', 'フォームデータが送信されていません');
        return res.redirect('/finance/entry');
    }

    // Joi バリデーション（必要であれば validatefinance のロジックを直接ここに書いてもOK）
    const { error } = financeSchema.validate(finance, { allowUnknown: true });
    if (error) {
        const msg = error.details.map(detail => detail.message).join(',');
        throw new ExpressError(msg, 400);
    }

    // 登録処理
    const loggedInUserId = req.user._id;

    const dateObj = new Date(finance.date);
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();

    const toJST = d => new Date(new Date(d).getTime() + 9 * 60 * 60 * 1000);

    // OCR金額があり、フォーム金額未入力ならOCR値を使う
    let registerAmount = amount;
    if ((!registerAmount || registerAmount === '') && extractedAmount) {
      registerAmount = extractedAmount;
    }

    const confirmDuplicate = req.body.confirmDuplicate === '1';
    const duplicateQuery = buildDuplicateQuery({
      ...finance,
      user: loggedInUserId,
      group: activeGroupId,
      amount: registerAmount
    });
    const duplicateEntry = await Finance.findOne(duplicateQuery);
    if (duplicateEntry && !confirmDuplicate) {
      let formData = req.body.finance || {};
      if (formData?.tags && Array.isArray(formData.tags)) {
        formData.tags = formData.tags.map(tag => (typeof tag === 'string' ? { name: tag } : tag));
      }
      if (formData?.['finance[tags]'] && Array.isArray(formData['finance[tags]'])) {
        formData.tags = formData['finance[tags]'].map(tag => (typeof tag === 'string' ? { name: tag } : tag));
      }
      return res.render('finance/entry', {
        page: 'entry',
        errors,
        formData,
        la_cfs,
        ex_cfs,
        in_items,
        dedu_cfs,
        saving_cfs,
        pay_cfs: global.pay_cfs,
        whos,
        allUsers,
        ocrAmount: extractedAmount || '',
        duplicateWarning: true,
        common_tags,
        financeTagRegistrationEnabled
      });
    }

    const newFinance = new Finance({
        ...finance,
        amount: registerAmount,
        saving_item: finance.cf === '貯蓄' && finance.saving_item !== 'Please Choice' ? finance.saving_item : '',
        user: loggedInUserId,
        group: activeGroupId,
        month,
        day,
        entry_date: toJST(new Date()),
        update_date: toJST(new Date()),
        memo: finance.memo || '',
        sub_tag: financeTagRegistrationEnabled ? normalizeSubTag(finance.sub_tag) : '',
        tags: financeTagRegistrationEnabled && Array.isArray(req.body.finance.tags)
            ? req.body.finance.tags.map((name, i) => ({
                name,
                category: req.body.finance.tag_categories?.[i] || '',
                price: Number(req.body.finance.tag_prices?.[i]) || null
              }))
            : [],
        corrected: {
            storeName: req.body.correctedStoreName,
            amount: req.body.correctedAmount,
            date: req.body.correctedDate,
            tags: (req.body['finance[tags]'] || []).map(tag => ({ name: tag }))
        }
    });

    // --- Handle tagItems for tags array ---
    const tagItems = financeTagRegistrationEnabled ? (req.body.tagItems || []) : [];
    const tags = [];

    if (Array.isArray(tagItems)) {
      tagItems.forEach(item => {
        if (item.name && item.category && item.price) {
          tags.push({
            name: item.name,
            category: item.category,
            price: parseInt(item.price, 10)
          });
        }
      });
    }

    newFinance.tags = financeTagRegistrationEnabled ? tags : [];

    await newFinance.save();
    await logAction({ req, action: '登録', target: '家計簿' });
    req.flash('success', '登録に成功しました');

    //続けて入力
    if (nextAction === 'duplicate') {
        const duplicateMessage = formatDuplicateMessage(newFinance);
        const cloneData = newFinance.toObject();
        delete cloneData._id;
        delete cloneData.entry_date;
        delete cloneData.update_date;
        delete cloneData.tags;
        cloneData.sub_tag = '';
        cloneData.income_item = '';
        cloneData.expense_item = '';
        cloneData.dedu_item = '';
        cloneData.saving_item = '';
        cloneData.amount = 0;

        const duplicatedFinance = new Finance(cloneData);

        await duplicatedFinance.save(); // ここ！保存する！！
        const { currentUser, availableGroups } = await getFinanceEditableGroupsForUser(req.user._id);

        const formattedDate = duplicatedFinance.date.toISOString().split('T')[0];
        const formattedEntryDate = toJST(new Date()).toLocaleString('ja-JP');
        const formattedUpdateDate = toJST(new Date()).toLocaleString('ja-JP');
         

        return res.render('finance/edit', {
            page: 'entry',
            errors: {},
            finance: { ...duplicatedFinance.toObject(), tags: duplicatedFinance.tags || [] },
            formattedDate,
            formattedEntryDate,
            formattedUpdateDate,
            duplicateMessage,
            duplicateWarning: false,
            continueEntry: true,
            la_cfs,
            ex_cfs,
            in_items,
            dedu_cfs,
            saving_cfs,
            pay_cfs,
            whos,
            allUsers,
            currentUser,
            availableGroups,
            common_tags,
            financeTagRegistrationEnabled
        });
    }

    await logAction({ req, action: '登録', target: '家計簿' });
    res.redirect('/finance/list');
}));

// 検索画面の表示
router.get('/search', isLoggedIn, async (req, res) => {
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    req.flash('error', 'アクティブなグループが選択されていません');
    return res.redirect('/group_list');
  }

  const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
  const yearForItems = getCurrentFiscalYear(fiscalStartMonth);
  await loadCfItems(req, yearForItems, fiscalStartMonth);

  // ex_cfsをfinance_ex_budgetから取得
  const budgetItems = await Budget.find({ group: activeGroupId, year: String(yearForItems) });
  const ex_cfs = ['Please Choice', ...budgetItems.map(item => item.expense_item)];

  // グループに所属するメンバー一覧を取得
  const group = await mongoose.model('Group').findById(activeGroupId).populate('members');
  const memberIds = group.members.map(member => member._id);

  // 支払方法：グループ内の各ユーザーの支払方法を取得（ユーザー→表示順）
  const rawPayItems = await PaymentItem.find({
    group: activeGroupId,
    user: { $in: memberIds }
  }).populate('user').sort({ 'user.displayname': 1, display_order: 1 });

  // ユーザーごとに display_order 順でまとめて、重複表示を避ける
  const seenItems = new Set();
  const mergedPayCfs = ['Please Choice'];

  const groupedByUser = rawPayItems.reduce((acc, item) => {
    const uid = item.user?._id?.toString();
    if (!uid) return acc;
    if (!acc[uid]) acc[uid] = [];
    acc[uid].push(item);
    return acc;
  }, {});

  for (const uid of Object.keys(groupedByUser)) {
    const userItems = groupedByUser[uid];
    userItems.sort((a, b) => a.display_order - b.display_order);
    for (const item of userItems) {
      if (!seenItems.has(item.paymentItem)) {
        seenItems.add(item.paymentItem);
        mergedPayCfs.push(item.paymentItem);
      }
    }
  }

  // 検索対象のメンバーリスト取得
  const whos = await FinanceUser.find({ _id: { $in: memberIds } });

  res.render('finance/search', {
    page: 'search',
    la_cfs,
    ex_cfs,
    in_items,
    dedu_cfs,
    saving_cfs,
    pay_cfs: mergedPayCfs,
    whos
  });
});

// 検索結果の表示
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.post('/search', catchAsync(async (req, res) => {
    const { date, date2, cf, expense_item, income_item, dedu_item, saving_item, payment_type, user, keyword, sub_tag } = req.body;

    // 検索クエリ用のオブジェクト
    let query = {};
    //activeGroupを検索条件に追加する
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }
    query.group = new mongoose.Types.ObjectId(activeGroupId);
    // 開始日と終了日が指定されていれば、その範囲で検索
    if (date && date2) {
        // 日付を文字列からDate型に変換
        const startDate = new Date(date);
        const endDate = new Date(date2);

        // 無効な日付がある場合はエラーメッセージ
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).send("無効な日付が入力されています。");
        }

        // UTC時間に変換（タイムゾーンを一致させる）
        const startUtc = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
        const endUtc = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

        query.date = { $gte: startUtc, $lte: endUtc };
    } else if (date) {
        // 開始日だけが指定された場合、その日以降で検索
        const startDate = new Date(date);
        const startUtc = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
        query.date = { $gte: startUtc };
    } else if (date2) {
        // 終了日だけが指定された場合、その日以前で検索
        const endDate = new Date(date2);
        const endUtc = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
        query.date = { $lte: endUtc };
    }

    // 他の条件が指定されていれば、その条件で検索
    if (cf && cf !== 'Please Choice') {
        if (cf === '支出') {
            query.cf = { $in: ['支出', '控除'] };
        } else {
            query.cf = cf;
        }
    }
    if (expense_item && expense_item !== 'Please Choice') {
        query.expense_item = expense_item;
    }
    if (income_item && income_item !== 'Please Choice') {
        query.income_item = income_item;
    }
    if (dedu_item && dedu_item !== 'Please Choice') {
        query.dedu_item = dedu_item;
    }
    if (saving_item && saving_item !== 'Please Choice') {
        query.saving_item = saving_item;
    }
    if (payment_type && payment_type !== 'Please Choice') {
        query.payment_type = payment_type;
    }
    if (sub_tag && sub_tag !== 'Please Choice') {
        query.sub_tag = sub_tag;
    }
    if (user && user !== 'Please Choice' && mongoose.Types.ObjectId.isValid(user)) {
        query.user = new mongoose.Types.ObjectId(user);
    }
    if (keyword && keyword.trim()) {
        query.content = { $regex: escapeRegExp(keyword.trim()), $options: 'i' };
    }
    // 条件に一致するデータを取得
    const finances = await Finance.find(query).sort({ update_date: -1 })
        .populate('user')  // ← displayname を使うために追加！
        .populate({
            path: 'group',
            populate: { path: 'createdBy' }
        });

    const count = await Finance.countDocuments(query);

    // 結果を検索結果ページに渡す
    const currentUser = await FinanceUser.findById(req.user._id).populate('groups');

    // フィルタバー用データ（支払種別はグループ全体から重複排除、メンバーはグループ）
    const group = await mongoose.model('Group').findById(activeGroupId).populate('members');
    const memberIds = group.members.map(member => member._id);
    const rawPayItems = await PaymentItem.find({ group: activeGroupId, user: { $in: memberIds } }).populate('user').sort({ 'user.displayname': 1, display_order: 1 });
    const seenPay = new Set();
    const mergedPayCfs = ['Please Choice'];
    const groupedByUser = rawPayItems.reduce((acc, item) => {
      const uid = item.user?._id?.toString();
      if (!uid) return acc; if (!acc[uid]) acc[uid] = []; acc[uid].push(item); return acc;
    }, {});
    for (const uid of Object.keys(groupedByUser)) {
      const userItems = groupedByUser[uid]; userItems.sort((a,b)=>a.display_order-b.display_order);
      for (const it of userItems) { if (!seenPay.has(it.paymentItem)) { seenPay.add(it.paymentItem); mergedPayCfs.push(it.paymentItem); } }
    }

    // 候補リストの準備（区分2=明細項目用）
    const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
    const yearForItems = getCurrentFiscalYear(fiscalStartMonth);
    await loadCfItems(req, yearForItems, fiscalStartMonth);
    const budgetItems = await Budget.find({ group: activeGroupId, year: String(yearForItems) });
    const ex_cfs = budgetItems.map(item => item.expense_item);
    const sub_tag_options = (await Finance.distinct('sub_tag', { group: new mongoose.Types.ObjectId(activeGroupId) }))
      .filter(v => v && v !== 'Please Choice')
      .sort();

    res.render('finance/search_results', {
        finances,
        count,
        page: 'search',
        currentUser,  // ← これを追加！
        enableFilterBar: true,
        filters: {
          from: date || '', to: date2 || '',
          payment_type: (payment_type && payment_type !== 'Please Choice') ? payment_type : 'Please Choice',
          sub_tag: sub_tag || '',
          user: (user && mongoose.Types.ObjectId.isValid(user)) ? user : '',
          cf, expense_item, income_item, dedu_item, saving_item,
          keyword: keyword || ''
        },
        pay_cfs: mergedPayCfs,
        whos: group.members,
        la_cfs,
        ex_cfs,
        in_items,
        dedu_cfs,
        saving_cfs,
        sub_tag_options
        }); 
}));

// 検索結果（GET, 並び替え・追加絞り込み用）
router.get('/search/results', isLoggedIn, catchAsync(async (req, res) => {
  // 正規化: 同名パラメータ重複による配列化を回避
  const pick = v => Array.isArray(v) ? v[v.length - 1] : v;
  const from = pick(req.query.from);
  const to = pick(req.query.to);
  const payment_type = pick(req.query.payment_type);
  const user = pick(req.query.user);
  const cf = pick(req.query.cf);
  const expense_item = pick(req.query.expense_item);
  const income_item = pick(req.query.income_item);
  const dedu_item = pick(req.query.dedu_item);
  const saving_item = pick(req.query.saving_item);
  const sub_tag = pick(req.query.sub_tag);
  const keyword = pick(req.query.keyword);
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    req.flash('error', 'アクティブなグループが選択されていません');
    return res.redirect('/group_list');
  }

  const query = { group: new mongoose.Types.ObjectId(activeGroupId) };
  if (from || to) {
    const startDate = from ? new Date(from) : null;
    const endDate = to ? new Date(to) : null;
    if (startDate) startDate.setHours(0,0,0,0);
    if (endDate) endDate.setHours(23,59,59,999);
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }

  if (cf && cf !== 'Please Choice') {
    if (cf === '支出') {
      query.cf = { $in: ['支出', '控除'] };
    } else {
      query.cf = cf;
    }
  }
  if (expense_item && expense_item !== 'Please Choice') {
    query.expense_item = expense_item;
  }
  if (income_item && income_item !== 'Please Choice') {
    query.income_item = income_item;
  }
  if (dedu_item && dedu_item !== 'Please Choice') {
    query.dedu_item = dedu_item;
  }
  if (saving_item && saving_item !== 'Please Choice') {
    query.saving_item = saving_item;
  }
  if (payment_type && payment_type !== 'Please Choice') query.payment_type = payment_type;
  if (sub_tag && sub_tag !== 'Please Choice') query.sub_tag = sub_tag;
  if (user && mongoose.Types.ObjectId.isValid(user)) query.user = new mongoose.Types.ObjectId(user);
  if (keyword && keyword.trim()) {
    query.content = { $regex: escapeRegExp(keyword.trim()), $options: 'i' };
  }

  const finances = await Finance.find(query).sort({ update_date: -1 })
    .populate('user')
    .populate({ path: 'group', populate: { path: 'createdBy' } });

  const count = await Finance.countDocuments(query);
  const currentUser = await FinanceUser.findById(req.user._id).populate('groups');

  // 支払種別/メンバー候補
  const group = await mongoose.model('Group').findById(activeGroupId).populate('members');
  const memberIds = group.members.map(member => member._id);
  const rawPayItems = await PaymentItem.find({ group: activeGroupId, user: { $in: memberIds } }).populate('user').sort({ 'user.displayname': 1, display_order: 1 });
  const seenPay = new Set();
  const mergedPayCfs = ['Please Choice'];
  const groupedByUser = rawPayItems.reduce((acc, item) => {
    const uid = item.user?._id?.toString();
    if (!uid) return acc; if (!acc[uid]) acc[uid] = []; acc[uid].push(item); return acc;
  }, {});
  for (const uid of Object.keys(groupedByUser)) {
    const userItems = groupedByUser[uid]; userItems.sort((a,b)=>a.display_order-b.display_order);
    for (const it of userItems) { if (!seenPay.has(it.paymentItem)) { seenPay.add(it.paymentItem); mergedPayCfs.push(it.paymentItem); } }
  }

  // 候補リストを同様に用意
  const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
  const yearForItems = getCurrentFiscalYear(fiscalStartMonth);
  await loadCfItems(req, yearForItems, fiscalStartMonth);
  const budgetItems = await Budget.find({ group: activeGroupId, year: String(yearForItems) });
  const ex_cfs = budgetItems.map(item => item.expense_item);
  const sub_tag_options = (await Finance.distinct('sub_tag', { group: new mongoose.Types.ObjectId(activeGroupId) }))
    .filter(v => v && v !== 'Please Choice')
    .sort();

  res.render('finance/search_results', {
    finances,
    count,
    page: 'search',
    currentUser,
    enableFilterBar: true,
    filters: {
      from: from || '', to: to || '',
      payment_type: (payment_type && payment_type !== 'Please Choice') ? payment_type : 'Please Choice',
      user: (user && mongoose.Types.ObjectId.isValid(user)) ? user : '',
      cf: cf || '', expense_item: expense_item || '',
      income_item: income_item || '',
      dedu_item: dedu_item || '',
      saving_item: saving_item || '',
      sub_tag: sub_tag || '',
      keyword: keyword || ''
    },
    pay_cfs: mergedPayCfs,
    whos: group.members,
    la_cfs,
    ex_cfs,
    in_items,
    dedu_cfs,
    saving_cfs,
    sub_tag_options
  });
}));

//◎一覧(list.ejs)
router.get('/list', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/login');
    }

    const objectId = typeof activeGroupId === 'string'
      ? new mongoose.Types.ObjectId(activeGroupId)
      : activeGroupId;

    // 並び順・件数
    const sortOrder = req.query.sortOrder || 'date';
    const limitParam = parseInt(req.query.limit, 10);
    const displayLimit = [20, 50, 100].includes(limitParam) ? limitParam : 20;
    // フィルタ（単一選択）
    const selectedCf = req.query.cf || '';
    const selectedCategory = req.query.category || '';
    const selectedPayment = req.query.payment_type || '';
    const selectedSubTag = req.query.sub_tag || '';
    const selectedKeyword = req.query.keyword || '';
    const selectedDateFrom = req.query.date_from || '';
    const selectedDateTo = req.query.date_to || '';
    const scope = req.query.scope === 'group' ? 'group' : 'user';
    const sortCriteria = sortOrder === 'update_date'
      ? { update_date: -1 }
      : { date: -1 };

    const baseCondition = scope === 'group'
      ? { group: objectId }
      : { group: objectId, user: req.user._id };
    const andConditions = [baseCondition];

    if (selectedCf) {
      andConditions.push({ cf: selectedCf });
    }
    if (selectedCategory) {
      andConditions.push({
        $or: [
          { expense_item: selectedCategory },
          { income_item: selectedCategory },
          { dedu_item: selectedCategory },
          { saving_item: selectedCategory }
        ]
      });
    }
    if (selectedPayment) {
      andConditions.push({ payment_type: selectedPayment });
    }
    if (selectedSubTag) {
      andConditions.push({ sub_tag: selectedSubTag });
    }
    if (selectedKeyword && selectedKeyword.trim()) {
      andConditions.push({ content: { $regex: escapeRegExp(selectedKeyword.trim()), $options: 'i' } });
    }
    if (selectedDateFrom || selectedDateTo) {
      const range = {};
      if (selectedDateFrom) {
        const from = new Date(selectedDateFrom);
        if (!Number.isNaN(from.getTime())) {
          range.$gte = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);
        }
      }
      if (selectedDateTo) {
        const to = new Date(selectedDateTo);
        if (!Number.isNaN(to.getTime())) {
          range.$lte = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);
        }
      }
      if (Object.keys(range).length > 0) {
        andConditions.push({ date: range });
      }
    }

    const query = andConditions.length > 1 ? { $and: andConditions } : baseCondition;

    // 新しい検索条件: groupとuserで絞り込み
    const finances = await Finance.find(query)
      .populate('user')
      .sort(sortCriteria)
      .limit(displayLimit);

    // Fallback: JSでソート（もしMongooseで正しくソートされない場合に備えて）
    // ただし、sortCriteriaで十分なため通常は不要
    // finances.sort((a, b) => {
    //   const dateA = a.update_date || a.entry_date;
    //   const dateB = b.update_date || b.entry_date;
    //   return dateB - dateA;
    // });

    const currentUser = await FinanceUser.findById(req.user._id).populate('groups');
    const count = (await Finance.find(query)).length;

    // ✅ 月間集計のための期間を取得
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 1);

    const thisMonthFinances = await Finance.find({
      group: objectId,
      date: { $gte: start, $lt: end }
    });

    // ✅ 集計
    let totalIncome = 0, totalExpense = 0, totalSaving = 0;
    for (let f of thisMonthFinances) {
      if (f.cf === '収入') totalIncome += f.amount;
      else if (f.cf === '貯蓄') totalSaving += f.amount;
      else if (f.cf === '支出' || f.cf === '控除') totalExpense += f.amount;
    }

    const balance = totalIncome - totalExpense - totalSaving;
    // リダイレクト復元用にクエリ付きURLを保存
    req.session.financeListReturn = req.originalUrl || '/finance/list';

    // フィルタ用オプション抽出
    const cfOptions = (await Finance.distinct('cf', baseCondition)).filter(v => v && v !== 'Please Choice');
    const categoryOptionsRaw = [
      ...(await Finance.distinct('income_item', baseCondition)),
      ...(await Finance.distinct('expense_item', baseCondition)),
      ...(await Finance.distinct('dedu_item', baseCondition)),
      ...(await Finance.distinct('saving_item', baseCondition))
    ];
    const categoryOptions = [...new Set(categoryOptionsRaw.filter(v => v && v !== 'Please Choice'))];
    const paymentOptions = (await Finance.distinct('payment_type', baseCondition)).filter(v => v && v !== 'Please Choice');
    const subTagOptions = (await Finance.distinct('sub_tag', baseCondition)).filter(v => v && v !== 'Please Choice');

    res.render('finance/list', {
      finances,
      count,
      currentUser,
      page: 'list',
      totalIncome,
      totalExpense,
      totalSaving,
      balance,
      sortOrder,
      displayLimit,
      selectedFilters: {
        cf: selectedCf,
        category: selectedCategory,
        payment: selectedPayment,
        sub_tag: selectedSubTag,
        keyword: selectedKeyword,
        date_from: selectedDateFrom,
        date_to: selectedDateTo,
        scope
      },
      filterOptions: {
        cfs: cfOptions,
        categories: categoryOptions,
        payments: paymentOptions,
        sub_tags: subTagOptions
      }
    });

  } catch (error) {
    console.error('一覧取得エラー:', error);
    res.status(500).send("サーバーエラーが発生しました");
  }
});

//◎詳細・編集(edit)画面の表示
router.get('/:id/edit', isLoggedIn, catchAsync(async (req, res) => {
    const { id } = req.params;
    const queryReturnTo = sanitizeReturnPath(req.query.returnTo, '');
    if (queryReturnTo) {
        req.session.financeListReturn = queryReturnTo;
    }
    const returnTo = queryReturnTo || getListRedirect(req);

    //ObjectId の形式チェック
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', '無効なIDです');
        return res.redirect('/finance/list');
    }
    const finance = await Finance.findById(id).populate('user').populate('group');
    if (!finance) {
        req.flash('error', 'データが存在しません');
        return res.redirect('/finance/list');
    }
    const { currentUser, availableGroups, availableGroupIds } = await getFinanceEditableGroupsForUser(req.user._id);
    const financeGroupId = normalizeIdString(finance.group);
    if (!availableGroupIds.has(financeGroupId)) {
        req.flash('error', 'このデータを編集する権限がありません');
        return res.redirect('/finance/list');
    }
    const fiscalStartMonth = await getGroupFiscalStartMonth(financeGroupId);
    const yearForItems = resolveFiscalYearForValue(finance.date, fiscalStartMonth);
    const {
      ex_cfs,
      in_items: formIncomeItems,
      dedu_cfs: formDeduItems,
      saving_cfs: formSavingItems,
      pay_cfs: formPayItems,
      allUsers,
      common_tags
    } = await buildFinanceFormOptions({
      groupId: financeGroupId,
      year: yearForItems,
      userId: req.user?._id,
      preserveValues: {
        income_item: finance.income_item,
        expense_item: finance.expense_item,
        dedu_item: finance.dedu_item,
        saving_item: finance.saving_item,
        payment_type: finance.payment_type,
        userId: finance.user?._id
      }
    });

    // 日付を "yyyy-MM-dd" 形式にフォーマット
    const formattedDate = finance.date.toISOString().split('T')[0];

    // 日付フォーマット関数
    function formatDateTime(date) {
      if (!date) return '日時なし';
      return date.toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    const formattedEntryDate = formatDateTime(finance.entry_date);
    const formattedUpdateDate = formatDateTime(finance.update_date);
    res.render('finance/edit', {
        page: 'edit',
        errors: {},
        finance,
        tagList: finance.tags || [],
        formattedDate,  // フォーマット済みの日付を渡す
        formattedEntryDate,
        formattedUpdateDate,
        la_cfs,
        ex_cfs,
        in_items: formIncomeItems,
        dedu_cfs: formDeduItems,
        saving_cfs: formSavingItems,
        pay_cfs: formPayItems,
        whos,
        allUsers,
        availableGroups,
        currentUser,
        duplicateWarning: req.query.duplicateWarning === '1',
        continueEntry: req.query.continueEntry === '1',
        returnTo,
        common_tags,
        financeTagRegistrationEnabled: req.user?.financeTagRegistrationEnabled === true
    });
}));

// JST に変換する関数
function getJSTDate() {
    const now = new Date();
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

//家計簿編集画面の更新
router.put('/:id', isLoggedIn, catchAsync(async (req, res) => {
    const { id } = req.params;  // これでURLパラメータのidを取得
    const returnTo = sanitizeReturnPath(req.body.returnTo, '');
    if (returnTo) {
        req.session.financeListReturn = returnTo;
    }
    const { finance } = req.body;
    const financeInput = finance || {};
    const nextAction = Array.isArray(req.body.nextAction) ? req.body.nextAction[0] : req.body.nextAction;
    const { date, cf, amount, payment_type, user } = financeInput;
    const { currentUser, availableGroups, availableGroupIds } = await getFinanceEditableGroupsForUser(req.user._id);
    const financeDoc = await Finance.findById(id).populate('user');
    if (!financeDoc) {
        req.flash('error', 'データが存在しません');
        return res.status(404).send("データが見つかりません");
    }
    const currentGroupId = normalizeIdString(financeDoc.group);
    if (!availableGroupIds.has(currentGroupId)) {
        req.flash('error', 'このデータを編集する権限がありません');
        return res.redirect('/finance/list');
    }
    const requestedGroupId = normalizeIdString(financeInput.group) || currentGroupId;
    const targetGroupId = availableGroupIds.has(requestedGroupId) ? requestedGroupId : currentGroupId;
    const fiscalStartMonth = await getGroupFiscalStartMonth(targetGroupId);
    const yearForItems = resolveFiscalYearForValue(date || financeDoc.date, fiscalStartMonth);
    const {
      ex_cfs,
      in_items: formIncomeItems,
      dedu_cfs: formDeduItems,
      saving_cfs: formSavingItems,
      pay_cfs: formPayItems,
      allUsers,
      common_tags
    } = await buildFinanceFormOptions({
      groupId: targetGroupId,
      year: yearForItems,
      userId: req.user?._id
    });
    const validUserIds = new Set(allUsers.map(candidate => normalizeIdString(candidate._id)));

    let errors = {};
    const financeTagRegistrationEnabled = req.user?.financeTagRegistrationEnabled === true;
    const tags = financeTagRegistrationEnabled ? extractTagsFromRequest(req.body.tagItems) : [];

    // 各項目のバリデーションをチェック
    if (!requestedGroupId) {
        errors.group = "グループは必須です";
    } else if (!availableGroupIds.has(requestedGroupId)) {
        errors.group = "選択したグループには変更できません";
    }
    if (!date) errors.date = "日付は必須です";
    if (!cf || cf === 'Please Choice') errors.cf = "収支区分は必須です。まだ登録は完了していません。";  // cf のチェック
    if (cf === '支出' && (!financeInput.expense_item || financeInput.expense_item === 'Please Choice')) {
        errors.expense_item = "支出区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '収入' && (!financeInput.income_item || financeInput.income_item === 'Please Choice')) {
        errors.income_item = "収入区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '控除' && (!financeInput.dedu_item || financeInput.dedu_item === 'Please Choice')) {
        errors.dedu_item = "控除区分は必須です。まだ登録は完了していません。";
    }
    if (cf === '貯蓄' && (!financeInput.saving_item || financeInput.saving_item === 'Please Choice')) {
        errors.saving_item = "貯蓄区分は必須です。まだ登録は完了していません。";
    }
    if (!amount || amount === '') errors.amount = "金額は必須です";  // amount の空チェック
    if (!payment_type || payment_type === 'Please Choice') errors.payment_type = "支払種別は必須です、まだ登録は完了してません。";
    if (!user || user === 'Please Choice') {
        errors.user = "対象者は必須です";
    } else if (!validUserIds.has(normalizeIdString(user))) {
        errors.user = "選択した使用者はこのグループでは利用できません";
    }
    if (payment_type && payment_type !== 'Please Choice' && !formPayItems.includes(payment_type)) {
        errors.payment_type = "選択した支払種別はこのグループでは利用できません";
    }

    //エラーがあればそのままビューに戻す
    if (Object.keys(errors).length > 0) {
        return res.render('finance/edit', {
            page: 'edit',
            errors,
            finance: { ...financeDoc.toObject(), ...financeInput, _id: id, group: targetGroupId, tags },
            formattedDate: date,
            formattedEntryDate: '',
            formattedUpdateDate: '',
            la_cfs,
            ex_cfs,
            in_items: formIncomeItems,
            dedu_cfs: formDeduItems,
            saving_cfs: formSavingItems,
            pay_cfs: formPayItems,
            whos,
            allUsers,
            availableGroups,
            currentUser,
            duplicateWarning: false,
            returnTo,
            common_tags,
            financeTagRegistrationEnabled
        });
    }

    if (financeInput.cf === 'Please Choice') financeInput.cf = '';
    if (financeInput.payment_type === 'Please Choice') financeInput.payment_type = '';
    if (financeInput.user === 'Please Choice') financeInput.user = '';
    if (financeInput.income_item === 'Please Choice') financeInput.income_item = '';
    if (financeInput.expense_item === 'Please Choice') financeInput.expense_item = '';
    if (financeInput.dedu_item === 'Please Choice') financeInput.dedu_item = '';
    if (financeInput.saving_item === 'Please Choice') financeInput.saving_item = '';

    // `date` から month, day を抽出
    const dateObj = new Date(financeInput.date);
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();

    // 更新
    Object.assign(financeDoc, {
        ...financeInput,
        saving_item: financeInput.cf === '貯蓄' && financeInput.saving_item !== 'Please Choice' ? financeInput.saving_item : '',
        income_item: financeInput.income_item === 'Please Choice' || !financeInput.income_item ? '' : financeInput.income_item,
        expense_item: financeInput.expense_item === 'Please Choice' || !financeInput.expense_item ? '' : financeInput.expense_item,
        dedu_item: financeInput.dedu_item === 'Please Choice' || !financeInput.dedu_item ? '' : financeInput.dedu_item,
        cf: financeInput.cf === 'Please Choice' ? '' : financeInput.cf,
        payment_type: financeInput.payment_type === 'Please Choice' ? '' : financeInput.payment_type,
        user: financeInput.user === 'Please Choice' ? '' : financeInput.user,
        group: targetGroupId,
        memo: financeInput.memo || '',
        sub_tag: financeTagRegistrationEnabled ? normalizeSubTag(financeInput.sub_tag) : '',
        update_date: getJSTDate(),
        month,
        day,
        tags
    });

    await financeDoc.save();
    // Fetch the updated document to ensure latest tags and fields
    const updatedFinance = await Finance.findById(id);

    //続けて入力するときは収支控除貯蓄の区分をは引きつがない
    if (nextAction === 'duplicate') {
        const duplicateMessage = formatDuplicateMessage(updatedFinance);
        const clone = updatedFinance.toObject();
        delete clone._id;
        delete clone.tags;
        clone.sub_tag = '';
        clone.entry_date = getJSTDate();
        clone.update_date = getJSTDate();
        clone.income_item = '';
        clone.expense_item = '';
        clone.dedu_item = '';
        clone.saving_item = '';
        clone.amount = 0;

        const newFinance = new Finance(clone);
        await newFinance.save();
        const duplicateGroupId = normalizeIdString(newFinance.group);
        const duplicateFiscalStartMonth = await getGroupFiscalStartMonth(duplicateGroupId);
        const duplicateYearForItems = resolveFiscalYearForValue(newFinance.date, duplicateFiscalStartMonth);
        const {
          ex_cfs: duplicateExCfs,
          in_items: duplicateIncomeItems,
          dedu_cfs: duplicateDeduItems,
          saving_cfs: duplicateSavingItems,
          pay_cfs: duplicatePayItems,
          allUsers: duplicateUsers,
          common_tags: duplicateCommonTags
        } = await buildFinanceFormOptions({
          groupId: duplicateGroupId,
          year: duplicateYearForItems,
          userId: req.user?._id,
          preserveValues: {
            payment_type: newFinance.payment_type,
            userId: newFinance.user
          }
        });
        const formattedDate = newFinance.date.toISOString().split('T')[0];
        return res.render('finance/edit', {
            page: 'entry',
            errors: {},
            finance: { ...newFinance.toObject(), tags: newFinance.tags || [] },
            formattedDate,
            formattedEntryDate: newFinance.entry_date.toLocaleString('ja-JP'),
            formattedUpdateDate: newFinance.update_date.toLocaleString('ja-JP'),
            duplicateMessage,
            duplicateWarning: false,
            continueEntry: true,
            la_cfs,
            ex_cfs: duplicateExCfs,
            in_items: duplicateIncomeItems,
            dedu_cfs: duplicateDeduItems,
            saving_cfs: duplicateSavingItems,
            pay_cfs: duplicatePayItems,
            whos,
            allUsers: duplicateUsers,
            currentUser,
            availableGroups,
            returnTo,
            common_tags: duplicateCommonTags,
            financeTagRegistrationEnabled
        });
    }

    req.flash('success', '更新に成功しました');
    await logAction({ req, action: '更新', target: '家計簿' });
    res.redirect(returnTo || getListRedirect(req)); // 更新後に一覧ページへリダイレクト
}));

//◎複製
router.post('/:id/duplicate', isLoggedIn, catchAsync(async (req, res) => {
    try {
        req.flash('success', 'コピーしたものを元に新規にレコード作成します');
        const { id } = req.params;
        const originalFinance = await Finance.findById(id);

        if (!originalFinance) {
            return res.status(404).json({ message: "データが見つかりません" });
        }

        // _idを除いて新しいドキュメントを作成
        const { _id, ...newFinanceData } = originalFinance.toObject();
        // タグ情報と特定フィールドを複製時に引き継がない
        const duplicatedData = {
            ...newFinanceData,
            tags: [], // タグ情報を複製時に引き継がない
            income_item: '',
            expense_item: '',
            dedu_item: '',
            saving_item: '',
            amount: 0
        };
        const newFinance = new Finance(duplicatedData);

        if (newFinance.cf === 'Please Choice') newFinance.cf = '';
        if (newFinance.payment_type === 'Please Choice') newFinance.payment_type = '';
        if (newFinance.user === 'Please Choice') newFinance.user = '';
        if (newFinance.income_item === 'Please Choice') newFinance.income_item = '';
        if (newFinance.expense_item === 'Please Choice') newFinance.expense_item = '';
        if (newFinance.dedu_item === 'Please Choice') newFinance.dedu_item = '';

        const duplicateCloneQuery = buildDuplicateQuery(newFinance);
        const duplicateCloneEntry = await Finance.findOne(duplicateCloneQuery);
        if (duplicateCloneEntry && req.body.confirmDuplicate !== '1') {
            return res.redirect(`/finance/${duplicateCloneEntry._id}/edit?duplicateWarning=1`);
        }

        await newFinance.save();
        await logAction({ req, action: '複製', target: '家計簿' });
        res.redirect(`/finance/${newFinance._id}/edit?continueEntry=1`);
    } catch (error) {
        res.status(500).json({ message: "サーバーエラーが発生しました" });
    }
}));


//家計簿データの削除(delete)
router.delete('/:id', isLoggedIn, catchAsync(async (req, res) => {
    const { id } = req.params;
    const deletedFinance = await Finance.findByIdAndDelete(id);
    if (!deletedFinance) {
        req.flash('error', 'データが見つかりません');
        return res.redirect('/finance/list');
    }
    req.flash('success', '削除に成功しました');
    await logAction({ req, action: '削除', target: '家計簿' });
    res.redirect(getListRedirect(req));
}));

//その他のルート

// 予算到達率メール通知（毎時、当月実績で判定）
cron.schedule('0 * * * *', async () => {
  try {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const daysInMonth = monthEnd.getDate();
    const dayRate = Math.round((today.getDate() / daysInMonth) * 1000) / 10;
    const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    const users = await FinanceUser.find({
      financeBudgetNoticeEnabled: true,
      isMail: { $ne: false }
    }).populate('groups');

    for (const user of users) {
      if (!user.email) continue;

      const thresholdsBase = Array.isArray(user.financeBudgetNoticeThresholds)
        ? user.financeBudgetNoticeThresholds
        : [50, 80, 90];
      const thresholds = Array.from(new Set(
        thresholdsBase
          .map(v => Number(v))
          .filter(v => Number.isInteger(v) && v >= 0 && v <= 100)
          .concat([100])
      ));

      const alertsByGroup = new Map();

      for (const group of user.groups || []) {
        const groupId = group._id;
        if (!isGroupServiceEnabled(user, groupId, 'finance')) continue;
        const noticeSetting = await FinanceBudgetNoticeSetting.findOne({ group: groupId });
        const noticeHour = Number.isInteger(noticeSetting?.noticeHour) ? noticeSetting.noticeHour : 8;
        if (today.getHours() !== noticeHour) continue;

        // 年度予算設定のアラート（年度開始月の1ヶ月前の1日）
        const fiscalStartMonth = normalizeFiscalStartMonth(group?.financeFiscalStartMonth);
        const alertMonth = fiscalStartMonth === 1 ? 12 : fiscalStartMonth - 1;
        if (today.getDate() === 1 && (today.getMonth() + 1) === alertMonth) {
          const nextFiscalYear = (getFiscalYearForDate(today, fiscalStartMonth) ?? today.getFullYear()) + 1;
          const lastAlertYear = Number.isInteger(noticeSetting?.lastFiscalAlertYear)
            ? noticeSetting.lastFiscalAlertYear
            : null;
          if (lastAlertYear !== nextFiscalYear) {
            const groupDoc = await Group.findById(groupId).populate('members').populate('createdBy');
            const recipientSet = new Set();
            (groupDoc?.members || []).forEach((m) => {
              if (m && m.email && m.isMail !== false && isGroupServiceEnabled(m, groupId, 'finance')) {
                recipientSet.add(m.email);
              }
            });
            if (groupDoc?.createdBy && groupDoc.createdBy.email && groupDoc.createdBy.isMail !== false) {
              if (isGroupServiceEnabled(groupDoc.createdBy, groupId, 'finance')) {
                recipientSet.add(groupDoc.createdBy.email);
              }
            }
            const recipients = Array.from(recipientSet);
            if (recipients.length > 0) {
              const baseUrl = process.env.NODE_ENV === 'production'
                ? process.env.BASE_URL
                : 'http://localhost:3000';
              const budgetUrl = `${baseUrl}/finance/budget`;
              const fiscalYearLabel = `${nextFiscalYear}年度`;
              await sendMail({
                to: recipients,
                subject: `【家計簿】${fiscalYearLabel}の予算設定のご案内`,
                templateName: 'fiscalBudgetSetupNotice',
                templateData: {
                  groupName: groupDoc?.group_name || 'グループ未設定',
                  fiscalYearLabel,
                  fiscalStartMonth,
                  budgetUrl
                }
              });
              await FinanceBudgetNoticeSetting.findOneAndUpdate(
                { group: groupId },
                { lastFiscalAlertYear: nextFiscalYear },
                { upsert: true, new: true }
              );
            }
          }
        }

        const fiscalYear = getFiscalYearForDate(today, fiscalStartMonth) ?? today.getFullYear();
        const budgets = await Budget.find({ group: groupId, year: String(fiscalYear) }).lean();
        if (!budgets || budgets.length === 0) continue;

        const totalBudget = budgets.reduce((sum, b) => sum + (Number(b.budget) || 0), 0);

        const expenseAgg = await Finance.aggregate([
          {
            $match: {
              group: groupId,
              cf: '支出',
              user: user._id,
              date: { $gte: monthStart, $lte: monthEnd }
            }
          },
          {
            $group: {
              _id: '$expense_item',
              total: { $sum: '$amount' }
            }
          }
        ]);
        const itemTotals = new Map(expenseAgg.map(r => [r._id || '未分類', Number(r.total) || 0]));
        const totalActual = Array.from(itemTotals.values()).reduce((sum, v) => sum + v, 0);

        const existingNotices = await FinanceBudgetNotice.find({
          user: user._id,
          group: groupId,
          month: monthKey
        }).lean();
        const existingSet = new Set(
          existingNotices.map(n => `${n.targetType}|${n.targetKey}|${n.threshold}`)
        );

        const groupAlerts = [];

        let totalRate = 0;
        if (totalBudget > 0) {
          totalRate = Math.round((totalActual / totalBudget) * 1000) / 10;
          thresholds.forEach(threshold => {
            const key = `total|TOTAL|${threshold}`;
            if (totalRate >= threshold && !existingSet.has(key)) {
              groupAlerts.push({
                targetLabel: '支出合計',
                threshold,
                actualRate: totalRate,
                budget: totalBudget,
                actual: totalActual,
                targetKey: 'TOTAL',
                targetType: 'total'
              });
            }
          });
        }

        budgets.forEach((b) => {
          const budgetValue = Number(b.budget) || 0;
          if (budgetValue <= 0) return;
          const itemName = b.expense_item || '未分類';
          const actualValue = itemTotals.get(itemName) || 0;
          const itemRate = Math.round((actualValue / budgetValue) * 1000) / 10;
          const satisfied = thresholds.filter(t => itemRate >= t);
          if (satisfied.length === 0) return;
          const threshold = Math.max(...satisfied);
          const key = `item|${itemName}|${threshold}`;
          if (!existingSet.has(key)) {
            groupAlerts.push({
              targetLabel: itemName,
              threshold,
              actualRate: itemRate,
              budget: budgetValue,
              actual: actualValue,
              targetKey: itemName,
              targetType: 'item',
              over: true
            });
          }
        });

        if (groupAlerts.length === 0) continue;

        const groupName = group.group_name || 'グループ未設定';
        alertsByGroup.set(groupId.toString(), { groupName, alerts: groupAlerts, totalRate });

        const insertDocs = groupAlerts.map(a => ({
          user: user._id,
          group: groupId,
          month: monthKey,
          targetType: a.targetType,
          targetKey: a.targetKey,
          threshold: a.threshold
        }));
        if (insertDocs.length > 0) {
          try {
            await FinanceBudgetNotice.insertMany(insertDocs, { ordered: false });
          } catch (err) {
            // unique制約の重複は無視
          }
        }
      }

      if (alertsByGroup.size === 0) continue;

      const baseUrl = process.env.NODE_ENV === 'production' ? process.env.BASE_URL : 'http://localhost:3000';
      await sendMail({
        to: user.email,
        subject: `【家計簿】予算の到達状況（${monthKey}）`,
        templateName: 'budgetNotice',
        templateData: {
          name: user.displayname || user.username,
          month: monthKey,
          dayRate,
          groups: Array.from(alertsByGroup.values()),
          budgetUrl: `${baseUrl}/finance/budget`
        }
      });
    }
  } catch (error) {
    console.error('Budget notice cron error:', error);
  }
}, {
  timezone: 'Asia/Tokyo'
});


// 前月の締め完了（ユーザーがボタンで完了）
router.post('/month-close/complete', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/top');
    }

    const now = new Date();
    const { monthKey, monthLabel, start, end, year } = getPreviousMonthMeta(now);

    await FinanceCloseStatus.findOneAndUpdate(
      { user: req.user._id, group: groupId, month: monthKey },
      { completed: true, completedAt: now },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const group = await Group.findById(groupId).populate('members').populate('createdBy');
    if (!group) {
      req.flash('error', 'グループ情報が見つかりませんでした');
      return res.redirect(req.body.redirectTo || '/finance/top');
    }

    const normalizeId = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (value._id) return value._id.toString();
      return null;
    };
    const memberIds = new Set(
      (group.members || [])
        .filter(m => isGroupServiceEnabled(m, groupId, 'finance'))
        .map(m => normalizeId(m))
        .filter(Boolean)
    );
    if (isGroupServiceEnabled(group.createdBy, groupId, 'finance')) {
      const createdById = normalizeId(group.createdBy);
      if (createdById) {
        memberIds.add(createdById);
      }
    }
    const memberIdList = Array.from(memberIds)
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));

    const completedCount = await FinanceCloseStatus.countDocuments({
      group: groupId,
      month: monthKey,
      completed: true,
      user: { $in: memberIdList }
    });

    if (completedCount === memberIdList.length && memberIdList.length > 0) {
      const existingClose = await FinanceCloseGroup.findOne({ group: groupId, month: monthKey });
      let shouldNotify = false;
      if (!existingClose || !existingClose.closed) {
        await FinanceCloseGroup.findOneAndUpdate(
          { group: groupId, month: monthKey },
          { closed: true, closedAt: now },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        shouldNotify = true;
      } else if (!existingClose.notifiedAt) {
        shouldNotify = true;
      }

      if (shouldNotify) {
        const objectId = typeof groupId === 'string'
          ? new mongoose.Types.ObjectId(groupId)
          : groupId;

        const totalsAgg = await Finance.aggregate([
          {
            $match: {
              group: objectId,
              date: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: '$cf',
              total: { $sum: '$amount' }
            }
          }
        ]);
        const totalsMap = new Map(totalsAgg.map(r => [r._id, Number(r.total) || 0]));
        const totals = {
          income: totalsMap.get('収入') || 0,
          deduction: totalsMap.get('控除') || 0,
          expense: totalsMap.get('支出') || 0,
          saving: totalsMap.get('貯蓄') || 0
        };
        totals.balance = totals.income - totals.expense - totals.saving - totals.deduction;

        const budgets = await Budget.find({ group: objectId, year }).lean();
        const expenseAgg = await Finance.aggregate([
          {
            $match: {
              group: objectId,
              cf: '支出',
              date: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: '$expense_item',
              total: { $sum: '$amount' }
            }
          }
        ]);
        const actualMap = new Map(expenseAgg.map(r => [r._id || '未分類', Number(r.total) || 0]));

        const overItems = budgets
          .map((b) => {
            const budgetValue = Number(b.budget) || 0;
            if (budgetValue <= 0) return null;
            const name = b.expense_item || '未分類';
            const actual = actualMap.get(name) || 0;
            if (actual <= budgetValue) return null;
            const overAmount = actual - budgetValue;
            const overRate = Math.round((actual / budgetValue) * 1000) / 10;
            return {
              name,
              budget: budgetValue,
              actual,
              overAmount,
              overRate
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.overAmount - a.overAmount);

        const recipientSet = new Set();
        (group.members || []).forEach((m) => {
          if (m && m.email && m.isMail !== false && isGroupServiceEnabled(m, groupId, 'finance')) {
            recipientSet.add(m.email);
          }
        });
        if (group.createdBy && group.createdBy.email && group.createdBy.isMail !== false) {
          if (isGroupServiceEnabled(group.createdBy, groupId, 'finance')) {
            recipientSet.add(group.createdBy.email);
          }
        }
        const recipients = Array.from(recipientSet);
        if (recipients.length > 0) {
          const baseUrl = process.env.NODE_ENV === 'production'
            ? process.env.BASE_URL
            : 'http://localhost:3000';
          const dashboardUrl = `${baseUrl}/export/dashboard/monthly-g?ym=${monthKey}`;
          await sendMail({
            to: recipients,
            subject: `【家計簿】${monthKey} 月度の家計簿登録完了`,
            templateName: 'financeCloseNotice',
            templateData: {
              name: req.user.displayname || req.user.username,
              month: monthLabel,
              groupName: group.group_name || 'グループ未設定',
              totals,
              overItems,
              dashboardUrl
            }
          });
          await FinanceCloseGroup.findOneAndUpdate(
            { group: groupId, month: monthKey },
            { notifiedAt: new Date() }
          );
        }
      }
    }

    req.flash('success', `${monthLabel}の入力完了を登録しました`);
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  } catch (err) {
    console.error('月度入力完了エラー:', err);
    req.flash('error', '入力完了の登録に失敗しました');
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  }
});

// 前月の締めを未完了に戻す（本人のみ）
router.post('/month-close/undo', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/top');
    }
    const now = new Date();
    const { monthKey, monthLabel } = getPreviousMonthMeta(now);

    await FinanceCloseStatus.findOneAndUpdate(
      { user: req.user._id, group: groupId, month: monthKey },
      { completed: false, completedAt: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await FinanceCloseGroup.findOneAndUpdate(
      { group: groupId, month: monthKey },
      { closed: false },
      { new: true }
    );

    req.flash('success', `${monthLabel}の入力完了を未完了に戻しました`);
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  } catch (err) {
    console.error('月度入力完了の取り消しエラー:', err);
    req.flash('error', '未完了への戻しに失敗しました');
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  }
});

// 前年の締め完了（ユーザーがボタンで完了）
router.post('/year-close/complete', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/top');
    }

    const now = new Date();
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const { year, yearLabel, start, end } = getPreviousYearMeta(now, fiscalStartMonth);

    await FinanceCloseYearStatus.findOneAndUpdate(
      { user: req.user._id, group: groupId, year },
      { completed: true, completedAt: now },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const group = await Group.findById(groupId).populate('members').populate('createdBy');
    if (!group) {
      req.flash('error', 'グループ情報が見つかりませんでした');
      return res.redirect(req.body.redirectTo || '/finance/top');
    }

    const normalizeId = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (value._id) return value._id.toString();
      return null;
    };
    const memberIds = new Set(
      (group.members || [])
        .filter(m => isGroupServiceEnabled(m, groupId, 'finance'))
        .map(m => normalizeId(m))
        .filter(Boolean)
    );
    if (isGroupServiceEnabled(group.createdBy, groupId, 'finance')) {
      const createdById = normalizeId(group.createdBy);
      if (createdById) {
        memberIds.add(createdById);
      }
    }
    const memberIdList = Array.from(memberIds)
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));

    const completedCount = await FinanceCloseYearStatus.countDocuments({
      group: groupId,
      year,
      completed: true,
      user: { $in: memberIdList }
    });

    if (completedCount === memberIdList.length && memberIdList.length > 0) {
      const existingClose = await FinanceCloseYearGroup.findOne({ group: groupId, year });
      let shouldNotify = false;
      if (!existingClose || !existingClose.closed) {
        await FinanceCloseYearGroup.findOneAndUpdate(
          { group: groupId, year },
          { closed: true, closedAt: now },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        shouldNotify = true;
      } else if (!existingClose.notifiedAt) {
        shouldNotify = true;
      }

      if (shouldNotify) {
        const objectId = typeof groupId === 'string'
          ? new mongoose.Types.ObjectId(groupId)
          : groupId;

        const totalsAgg = await Finance.aggregate([
          {
            $match: {
              group: objectId,
              date: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: '$cf',
              total: { $sum: '$amount' }
            }
          }
        ]);
        const totalsMap = new Map(totalsAgg.map(r => [r._id, Number(r.total) || 0]));
        const totals = {
          income: totalsMap.get('収入') || 0,
          deduction: totalsMap.get('控除') || 0,
          expense: totalsMap.get('支出') || 0,
          saving: totalsMap.get('貯蓄') || 0
        };
        totals.balance = totals.income - totals.expense - totals.saving - totals.deduction;

        const budgets = await Budget.find({ group: objectId, year: String(year) }).lean();
        const expenseAgg = await Finance.aggregate([
          {
            $match: {
              group: objectId,
              cf: '支出',
              date: { $gte: start, $lte: end }
            }
          },
          {
            $group: {
              _id: '$expense_item',
              total: { $sum: '$amount' }
            }
          }
        ]);
        const actualMap = new Map(expenseAgg.map(r => [r._id || '未分類', Number(r.total) || 0]));

        const overItems = budgets
          .map((b) => {
            const monthlyBudget = Number(b.budget) || 0;
            if (monthlyBudget <= 0) return null;
            const budgetValue = monthlyBudget * 12;
            const name = b.expense_item || '未分類';
            const actual = actualMap.get(name) || 0;
            if (actual <= budgetValue) return null;
            const overAmount = actual - budgetValue;
            const overRate = Math.round((actual / budgetValue) * 1000) / 10;
            return {
              name,
              budget: budgetValue,
              actual,
              overAmount,
              overRate
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.overAmount - a.overAmount);

        const recipientSet = new Set();
        (group.members || []).forEach((m) => {
          if (m && m.email && m.isMail !== false && isGroupServiceEnabled(m, groupId, 'finance')) {
            recipientSet.add(m.email);
          }
        });
        if (group.createdBy && group.createdBy.email && group.createdBy.isMail !== false) {
          if (isGroupServiceEnabled(group.createdBy, groupId, 'finance')) {
            recipientSet.add(group.createdBy.email);
          }
        }
        const recipients = Array.from(recipientSet);
        if (recipients.length > 0) {
          const baseUrl = process.env.NODE_ENV === 'production'
            ? process.env.BASE_URL
            : 'http://localhost:3000';
          const dashboardUrl = `${baseUrl}/export/dashboard/yearly-g?year=${year}`;
          await sendMail({
            to: recipients,
            subject: `【家計簿】${yearLabel}の家計簿登録完了`,
            templateName: 'financeYearCloseNotice',
            templateData: {
              name: req.user.displayname || req.user.username,
              yearLabel,
              groupName: group.group_name || 'グループ未設定',
              totals,
              overItems,
              dashboardUrl
            }
          });
          await FinanceCloseYearGroup.findOneAndUpdate(
            { group: groupId, year },
            { notifiedAt: new Date() }
          );
        }
      }
    }

    req.flash('success', `${yearLabel}の入力完了を登録しました`);
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  } catch (err) {
    console.error('年度入力完了エラー:', err);
    req.flash('error', '入力完了の登録に失敗しました');
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  }
});

// 前年の締めを未完了に戻す（本人のみ）
router.post('/year-close/undo', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/top');
    }
    const now = new Date();
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const { year, yearLabel } = getPreviousYearMeta(now, fiscalStartMonth);

    await FinanceCloseYearStatus.findOneAndUpdate(
      { user: req.user._id, group: groupId, year },
      { completed: false, completedAt: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await FinanceCloseYearGroup.findOneAndUpdate(
      { group: groupId, year },
      { closed: false },
      { new: true }
    );

    req.flash('success', `${yearLabel}の入力完了を未完了に戻しました`);
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  } catch (err) {
    console.error('年度入力完了の取り消しエラー:', err);
    req.flash('error', '未完了への戻しに失敗しました');
    res.redirect(req.body.redirectTo || req.headers.referer || '/finance/top');
  }
});

const resolveBudgetYear = (value, fallbackYear) => {
  const raw = String(value || '').trim();
  if (/^\d{4}$/.test(raw)) return raw;
  return String(fallbackYear);
};

const buildDefaultBudgetRows = (names = [], keyField = 'item') => (
  names.map((name, index) => ({
    display_order: index + 1,
    [keyField]: name,
    budget: 0
  }))
);

const sanitizeBudgetRow = (row, keyField) => {
  const rawKey = row?.[keyField];
  const key = String(rawKey || '').trim();
  if (!key) return null;
  return {
    display_order: Number.isFinite(Number(row?.display_order)) ? Number(row.display_order) : 9999,
    [keyField]: key,
    budget: Number(row?.budget) || 0
  };
};

const sanitizeBudgetRowsForForm = (rows = [], keyField) => (
  rows
    .map((row, index) => {
      const normalized = sanitizeBudgetRow(row, keyField);
      if (!normalized) return null;
      return {
        ...normalized,
        display_order: normalized.display_order < 9999 ? normalized.display_order : index + 1
      };
    })
    .filter(Boolean)
);

const normalizeBudgetLaCf = (value) => {
  const raw = String(value || '').trim();
  if (raw === '収入項目' || raw === 'income') return '収入項目';
  if (raw === '控除項目' || raw === 'deduction') return '控除項目';
  if (raw === '貯蓄項目' || raw === 'saving') return '貯蓄項目';
  return '';
};

const getFinanceBudgetMembers = async (groupId) => {
  const groupDoc = await Group.findById(groupId)
    .populate('members', 'displayname username servicesByGroup')
    .populate('createdBy', 'displayname username servicesByGroup');
  if (!groupDoc) return { groupDoc: null, members: [] };

  const memberMap = new Map();
  const pushMember = (member) => {
    if (!member) return;
    if (!isGroupServiceEnabled(member, groupId, 'finance')) return;
    const id = normalizeIdString(member._id || member);
    if (!id || memberMap.has(id)) return;
    memberMap.set(id, {
      id,
      name: member.displayname || member.username || '未設定'
    });
  };

  (groupDoc.members || []).forEach(pushMember);
  pushMember(groupDoc.createdBy);

  const members = Array.from(memberMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { groupDoc, members };
};

const seedPersonalBudgetsIfMissing = async ({ groupId, year, members = [] }) => {
  const yearStr = String(year);
  if (!groupId || members.length === 0) return false;

  const [expenseExists, itemExists] = await Promise.all([
    PersonalBudget.exists({ group: groupId, year: yearStr }),
    PersonalItem.exists({ group: groupId, year: yearStr })
  ]);
  if (expenseExists || itemExists) return false;

  const [groupExpenseRows, groupItemRowsForYear] = await Promise.all([
    Budget.find({ group: groupId, year: yearStr }).sort({ display_order: 1 }).lean(),
    Items.find({
      group: groupId,
      year: yearStr,
      la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] }
    }).sort({ la_cf: 1, display_order: 1 }).lean()
  ]);

  let groupItemRows = groupItemRowsForYear;
  if (groupItemRows.length === 0) {
    groupItemRows = await Items.find({
      group: groupId,
      year: { $exists: false },
      la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] }
    }).sort({ la_cf: 1, display_order: 1 }).lean();
  }

  if (groupExpenseRows.length === 0 && groupItemRows.length === 0) {
    return false;
  }

  const now = new Date();
  const firstMemberId = members[0]?.id;
  if (!firstMemberId) return false;

  const expenseSeeds = [];
  const itemSeeds = [];

  members.forEach((member) => {
    const isFirstMember = member.id === firstMemberId;
    groupExpenseRows.forEach((row, index) => {
      const normalized = sanitizeBudgetRow(row, 'expense_item');
      if (!normalized) return;
      expenseSeeds.push({
        display_order: normalized.display_order < 9999 ? normalized.display_order : index + 1,
        year: yearStr,
        expense_item: normalized.expense_item,
        budget: isFirstMember ? normalized.budget : 0,
        group: groupId,
        user: member.id,
        entry_date: now,
        update_date: now
      });
    });

    groupItemRows.forEach((row, index) => {
      const normalized = sanitizeBudgetRow(row, 'item');
      const normalizedLaCf = normalizeBudgetLaCf(row?.la_cf);
      if (!normalized || !normalizedLaCf) return;
      itemSeeds.push({
        display_order: normalized.display_order < 9999 ? normalized.display_order : index + 1,
        la_cf: normalizedLaCf,
        item: normalized.item,
        year: yearStr,
        budget: isFirstMember ? normalized.budget : 0,
        group: groupId,
        user: member.id,
        entry_date: now,
        update_date: now
      });
    });
  });

  if (expenseSeeds.length > 0) {
    await PersonalBudget.insertMany(expenseSeeds);
  }
  if (itemSeeds.length > 0) {
    await PersonalItem.insertMany(itemSeeds);
  }

  return expenseSeeds.length > 0 || itemSeeds.length > 0;
};

const aggregateRowsForGroup = (rows = [], keyField, laCf = null) => {
  const map = new Map();
  rows.forEach((row) => {
    if (laCf && String(row?.la_cf || '') !== laCf) return;
    const normalized = sanitizeBudgetRow(row, keyField);
    if (!normalized) return;
    const key = normalized[keyField];
    const current = map.get(key);
    if (!current) {
      map.set(key, {
        item: key,
        display_order: normalized.display_order,
        budget: normalized.budget
      });
      return;
    }
    current.display_order = Math.min(current.display_order, normalized.display_order);
    current.budget += normalized.budget;
  });

  return Array.from(map.values())
    .sort((a, b) => {
      if (a.display_order !== b.display_order) return a.display_order - b.display_order;
      return a.item.localeCompare(b.item, 'ja');
    })
    .map((row, index) => ({
      ...row,
      display_order: Number.isFinite(row.display_order) && row.display_order < 9999
        ? row.display_order
        : index + 1
    }));
};

const aggregatePersonalBudgetsToGroup = async ({ groupId, year }) => {
  const yearStr = String(year);
  const { members } = await getFinanceBudgetMembers(groupId);
  const memberObjectIds = members
    .map((m) => m.id)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const personalExpenseQuery = { group: groupId, year: yearStr };
  const personalItemQuery = { group: groupId, year: yearStr };
  if (memberObjectIds.length > 0) {
    personalExpenseQuery.user = { $in: memberObjectIds };
    personalItemQuery.user = { $in: memberObjectIds };
  } else {
    personalExpenseQuery.user = { $in: [] };
    personalItemQuery.user = { $in: [] };
  }

  const [personalExpenseRows, personalItemRows] = await Promise.all([
    PersonalBudget.find(personalExpenseQuery).lean(),
    PersonalItem.find(personalItemQuery).lean()
  ]);

  const now = new Date();
  const expenseRows = aggregateRowsForGroup(personalExpenseRows, 'expense_item').map((row, index) => ({
    display_order: row.display_order || index + 1,
    group: groupId,
    year: yearStr,
    expense_item: row.item,
    budget: Number(row.budget) || 0,
    entry_date: now,
    update_date: now
  }));

  const allowedLaCf = new Set(['収入項目', '控除項目', '貯蓄項目']);
  const itemMap = new Map();
  personalItemRows.forEach((doc) => {
    const la_cf = String(doc?.la_cf || '').trim();
    if (!allowedLaCf.has(la_cf)) return;
    const normalized = sanitizeBudgetRow(doc, 'item');
    if (!normalized) return;
    const key = `${la_cf}::${normalized.item}`;
    const current = itemMap.get(key);
    if (!current) {
      itemMap.set(key, {
        la_cf,
        item: normalized.item,
        display_order: normalized.display_order,
        budget: normalized.budget
      });
      return;
    }
    current.display_order = Math.min(current.display_order, normalized.display_order);
    current.budget += normalized.budget;
  });

  const itemRows = Array.from(itemMap.values())
    .sort((a, b) => {
      if (a.la_cf !== b.la_cf) return a.la_cf.localeCompare(b.la_cf, 'ja');
      if (a.display_order !== b.display_order) return a.display_order - b.display_order;
      return a.item.localeCompare(b.item, 'ja');
    })
    .map((row, index) => ({
      display_order: Number.isFinite(row.display_order) && row.display_order < 9999
        ? row.display_order
        : index + 1,
      group: groupId,
      year: yearStr,
      la_cf: row.la_cf,
      item: row.item,
      budget: Number(row.budget) || 0,
      entry_date: now,
      update_date: now
    }));

  await Budget.deleteMany({ group: groupId, year: yearStr });
  if (expenseRows.length > 0) {
    await Budget.insertMany(expenseRows);
  }

  await Items.deleteMany({
    group: groupId,
    year: yearStr,
    la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] }
  });
  if (itemRows.length > 0) {
    await Items.insertMany(itemRows);
  }
};

const buildMemberBreakdownRows = ({ docs = [], members = [], keyField, laCf = null }) => {
  const memberIds = members.map((member) => member.id);
  const memberSet = new Set(memberIds);
  const map = new Map();

  docs.forEach((doc) => {
    if (laCf && String(doc?.la_cf || '') !== laCf) return;
    const normalized = sanitizeBudgetRow(doc, keyField);
    if (!normalized) return;
    const userId = normalizeIdString(doc?.user);
    if (!userId || !memberSet.has(userId)) return;

    const key = normalized[keyField];
    let row = map.get(key);
    if (!row) {
      row = {
        item: key,
        total: 0,
        display_order: normalized.display_order,
        memberBudgets: {}
      };
      memberIds.forEach((id) => {
        row.memberBudgets[id] = 0;
      });
      map.set(key, row);
    }

    row.display_order = Math.min(row.display_order, normalized.display_order);
    row.total += normalized.budget;
    row.memberBudgets[userId] = (row.memberBudgets[userId] || 0) + normalized.budget;
  });

  return Array.from(map.values()).sort((a, b) => {
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return a.item.localeCompare(b.item, 'ja');
  });
};

const buildGroupOnlyRows = ({ docs = [], keyField, laCf = null }) => {
  const rows = aggregateRowsForGroup(docs, keyField, laCf);
  return rows.map((row) => ({
    item: row.item,
    total: row.budget,
    display_order: row.display_order,
    memberBudgets: {}
  }));
};

const CATEGORY_GROUP_TYPES = ['収入項目', '支出項目', '控除項目', '貯蓄項目'];

const normalizeCategoryGroupType = (value) => {
  const raw = String(value || '').trim();
  return CATEGORY_GROUP_TYPES.includes(raw) ? raw : '';
};

const uniqueOrderedStrings = (values = []) => {
  const seen = new Set();
  const ordered = [];
  values.forEach((value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    ordered.push(text);
  });
  return ordered;
};

const fetchCategoryGroupItemOptions = async (groupId, year) => {
  const yearStr = String(year);
  let [expenseRows, itemRows] = await Promise.all([
    Budget.find({ group: groupId, year: yearStr }).sort({ display_order: 1 }).lean(),
    Items.find({
      group: groupId,
      year: yearStr,
      la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目'] }
    }).sort({ la_cf: 1, display_order: 1 }).lean()
  ]);
  if (expenseRows.length === 0) {
    expenseRows = await Budget.find({ group: groupId, year: { $exists: false } }).sort({ display_order: 1 }).lean();
  }
  if (itemRows.length === 0) {
    itemRows = await Items.find({
      group: groupId,
      year: { $exists: false },
      la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目'] }
    }).sort({ la_cf: 1, display_order: 1 }).lean();
  }

  const incomeOptions = uniqueOrderedStrings(itemRows.filter((row) => row.la_cf === '収入項目').map((row) => row.item));
  const expenseOptions = uniqueOrderedStrings(expenseRows.map((row) => row.expense_item));
  const deductionOptions = uniqueOrderedStrings(itemRows.filter((row) => row.la_cf === '控除項目').map((row) => row.item));
  const savingOptions = uniqueOrderedStrings(itemRows.filter((row) => row.la_cf === '貯蓄項目').map((row) => row.item));

  return {
    '収入項目': incomeOptions.length ? incomeOptions : defaultInItems.slice(1),
    '支出項目': expenseOptions.length ? expenseOptions : ex_cfs,
    '控除項目': deductionOptions.length ? deductionOptions : defaultDeduCfs.slice(1),
    '貯蓄項目': savingOptions.length ? savingOptions : defaultSavingCfs.slice(1)
  };
};

const normalizeCategoryGroupRows = (rowsInput) => {
  const rows = Array.isArray(rowsInput) ? rowsInput : Object.values(rowsInput || {});
  return rows
    .map((row, index) => {
      const targetType = normalizeCategoryGroupType(row?.target_type);
      const name = String(row?.name || '').trim();
      if (!targetType || !name) return null;
      const rawItemNames = Array.isArray(row?.item_names)
        ? row.item_names
        : (row?.item_names ? [row.item_names] : []);
      return {
        display_order: index + 1,
        target_type: targetType,
        name,
        item_names: uniqueOrderedStrings(rawItemNames),
        show_in_monthly_calendar: row?.show_in_monthly_calendar === 'on'
          || row?.show_in_monthly_calendar === 'true'
          || row?.show_in_monthly_calendar === true
      };
    })
    .filter(Boolean);
};

//予算関連ルート
//予算設定のトップ画面表示
router.get('/budget', isLoggedIn, async (req, res) => {
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    req.flash('error', 'アクティブなグループが選択されていません');
    return res.redirect('/group_list');
  }

  const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
  const selectedYear = resolveBudgetYear(req.query.year, getCurrentFiscalYear(fiscalStartMonth));
  const [{ groupDoc, members }, matometeSetting, noticeSetting, categoryGroupItemOptions, categoryGroups] = await Promise.all([
    getFinanceBudgetMembers(activeGroupId),
    MatometeSetting.findOne({ group: activeGroupId }),
    FinanceBudgetNoticeSetting.findOne({ group: activeGroupId }),
    fetchCategoryGroupItemOptions(activeGroupId, selectedYear),
    FinanceItemCategoryGroup.find({ group: activeGroupId, year: selectedYear })
      .sort({ target_type: 1, display_order: 1, name: 1 })
      .lean()
  ]);

  if (!groupDoc) {
    req.flash('error', 'グループ情報が見つかりません');
    return res.redirect('/group_list');
  }

  res.render('finance/budgetTop', {
    activeGroupId,
    selectedYear,
    members,
    groupName: groupDoc.group_name || 'グループ',
    page: 'budget',
    fiscalStartMonth,
    noticeSettings: {
      enabled: req.user?.financeBudgetNoticeEnabled !== false,
      thresholds: Array.isArray(req.user?.financeBudgetNoticeThresholds) && req.user.financeBudgetNoticeThresholds.length > 0
        ? req.user.financeBudgetNoticeThresholds
        : [50, 80, 90],
      matometeReminderDays: Number.isInteger(matometeSetting?.reminderDays)
        ? matometeSetting.reminderDays
        : 7,
      matometeReminderHour: Number.isInteger(matometeSetting?.reminderHour)
        ? matometeSetting.reminderHour
        : 8,
      budgetNoticeHour: Number.isInteger(noticeSetting?.noticeHour)
        ? noticeSetting.noticeHour
        : 8,
      walletManagementEnabled: groupDoc?.financeWalletManagementEnabled === true
    },
    categoryGroupTypes: CATEGORY_GROUP_TYPES,
    categoryGroupItemOptions,
    categoryGroups,
    quickMenuOptions: FINANCE_QUICK_MENU_ITEMS,
    quickMenuEnabled: req.user?.financeQuickMenuEnabled !== false,
    quickMenuSettings: buildQuickMenuItems(req.user?.financeQuickMenuItems).map((item) => ({
      key: item.key,
      customLabel: item.customLabel
    })),
    financeTagRegistrationEnabled: req.user?.financeTagRegistrationEnabled === true
  });
});

// タグ登録設定
router.post('/budget/tag-settings', isLoggedIn, async (req, res) => {
  const enabled = req.body.tag_registration === 'enabled';

  await FinanceUser.findByIdAndUpdate(req.user._id, {
    financeTagRegistrationEnabled: enabled
  });

  req.flash('success', `タグ登録を「${enabled ? 'する' : 'しない'}」に更新しました`);
  res.redirect('/finance/budget');
});

// よく使う項目フローティングメニュー設定
router.post('/budget/quick-menu-settings', isLoggedIn, async (req, res) => {
  try {
    const rows = req.body?.quickMenu;
    const list = Array.isArray(rows) ? rows : Object.values(rows || {});
    const cleaned = normalizeQuickMenuItems(list);
    const enabledValue = req.body?.quickMenuEnabled;
    const quickMenuEnabled = Array.isArray(enabledValue)
      ? enabledValue.includes('true')
      : enabledValue !== 'false';

    await FinanceUser.findByIdAndUpdate(req.user._id, {
      financeQuickMenuEnabled: quickMenuEnabled,
      financeQuickMenuItems: cleaned
    });

    req.flash('success', 'よく使う項目の設定を更新しました');
  } catch (err) {
    console.error('よく使う項目設定更新エラー:', err);
    req.flash('error', 'よく使う項目の設定更新に失敗しました');
  }
  res.redirect('/finance/budget');
});

// 上位カテゴリー設定
router.post('/budget/category-groups', isLoggedIn, async (req, res) => {
  try {
    const groupId = normalizeIdString(req.session.activeGroupId);
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const year = resolveBudgetYear(req.body.year, getCurrentFiscalYear(fiscalStartMonth));
    const rows = normalizeCategoryGroupRows(req.body.categoryGroups);
    const now = new Date();

    await FinanceItemCategoryGroup.deleteMany({ group: groupId, year });
    if (rows.length > 0) {
      await FinanceItemCategoryGroup.insertMany(rows.map((row) => ({
        ...row,
        group: groupId,
        year,
        entry_date: now,
        update_date: now
      })));
    }

    req.flash('success', '上位カテゴリー設定を保存しました');
    return res.redirect(`/finance/budget?year=${encodeURIComponent(year)}`);
  } catch (err) {
    console.error('上位カテゴリー設定保存エラー:', err);
    req.flash('error', '上位カテゴリー設定の保存に失敗しました');
    return res.redirect('/finance/budget');
  }
});

// グループ予算確認画面
router.get('/budget/group-summary', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
    const selectedYear = resolveBudgetYear(req.query.year, getCurrentFiscalYear(fiscalStartMonth));
    const { groupDoc, members } = await getFinanceBudgetMembers(activeGroupId);
    if (!groupDoc) {
      req.flash('error', 'グループ情報が見つかりません');
      return res.redirect('/finance/budget');
    }

    await seedPersonalBudgetsIfMissing({
      groupId: activeGroupId,
      year: selectedYear,
      members
    });

    const memberObjectIds = members
      .map((member) => member.id)
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const personalExpenseQuery = { group: activeGroupId, year: selectedYear };
    const personalItemQuery = { group: activeGroupId, year: selectedYear };
    if (memberObjectIds.length > 0) {
      personalExpenseQuery.user = { $in: memberObjectIds };
      personalItemQuery.user = { $in: memberObjectIds };
    } else {
      personalExpenseQuery.user = { $in: [] };
      personalItemQuery.user = { $in: [] };
    }

    const [personalExpenseRows, personalItemRows, groupExpenseRows, groupItemRows] = await Promise.all([
      PersonalBudget.find(personalExpenseQuery).lean(),
      PersonalItem.find(personalItemQuery).lean(),
      Budget.find({ group: activeGroupId, year: selectedYear }).lean(),
      Items.find({ group: activeGroupId, year: selectedYear }).lean()
    ]);

    const hasPersonalData = personalExpenseRows.length > 0 || personalItemRows.length > 0;
    const expenseRows = hasPersonalData
      ? buildMemberBreakdownRows({ docs: personalExpenseRows, members, keyField: 'expense_item' })
      : buildGroupOnlyRows({ docs: groupExpenseRows, keyField: 'expense_item' });
    const incomeRows = hasPersonalData
      ? buildMemberBreakdownRows({ docs: personalItemRows, members, keyField: 'item', laCf: '収入項目' })
      : buildGroupOnlyRows({ docs: groupItemRows, keyField: 'item', laCf: '収入項目' });
    const deductionRows = hasPersonalData
      ? buildMemberBreakdownRows({ docs: personalItemRows, members, keyField: 'item', laCf: '控除項目' })
      : buildGroupOnlyRows({ docs: groupItemRows, keyField: 'item', laCf: '控除項目' });
    const savingRows = hasPersonalData
      ? buildMemberBreakdownRows({ docs: personalItemRows, members, keyField: 'item', laCf: '貯蓄項目' })
      : buildGroupOnlyRows({ docs: groupItemRows, keyField: 'item', laCf: '貯蓄項目' });

    res.render('finance/budgetGroupSummary', {
      selectedYear,
      groupName: groupDoc.group_name || 'グループ',
      members,
      hasPersonalData,
      sections: [
        { title: '収入項目', rows: incomeRows },
        { title: '控除項目', rows: deductionRows },
        { title: '貯蓄項目', rows: savingRows },
        { title: '支出項目', rows: expenseRows }
      ]
    });
  } catch (err) {
    console.error('❌ グループ予算確認の取得エラー:', err);
    req.flash('error', 'グループ予算確認の取得に失敗しました');
    res.redirect('/finance/budget');
  }
});

// 予算通知設定の保存
router.post('/budget/notice-settings', isLoggedIn, async (req, res) => {
  const enabled = req.body.notice_enabled === 'on';
  const raw = [req.body.notice_threshold1, req.body.notice_threshold2, req.body.notice_threshold3];
  const thresholds = raw
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v >= 0 && v <= 100);
  const unique = Array.from(new Set(thresholds)).slice(0, 3);

  await FinanceUser.findByIdAndUpdate(req.user._id, {
    financeBudgetNoticeEnabled: enabled,
    financeBudgetNoticeThresholds: unique.length > 0 ? unique : [50, 80, 90]
  });

  req.flash('success', '予算通知の設定を更新しました');
  res.redirect('/finance/budget');
});

// 年度の開始月設定
router.post('/budget/fiscal-start-month', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/budget');
    }
    const month = normalizeFiscalStartMonth(req.body.fiscal_start_month);
    await Group.findByIdAndUpdate(groupId, { financeFiscalStartMonth: month });
    req.flash('success', '年度の開始月を更新しました');
    return res.redirect('/finance/budget');
  } catch (err) {
    console.error('年度の開始月更新エラー:', err);
    req.flash('error', '年度の開始月の更新に失敗しました');
    return res.redirect('/finance/budget');
  }
});

// お財布管理設定
router.post('/budget/wallet-settings', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/finance/budget');
    }

    const enabled = req.body.wallet_management === 'enabled';
    await Group.findByIdAndUpdate(groupId, {
      financeWalletManagementEnabled: enabled
    });

    req.flash('success', `お財布管理を「${enabled ? 'する' : 'しない'}」に更新しました`);
    return res.redirect('/finance/budget');
  } catch (err) {
    console.error('お財布管理設定更新エラー:', err);
    req.flash('error', 'お財布管理設定の更新に失敗しました');
    return res.redirect('/finance/budget');
  }
});

// まとめて入力 催促メール設定の保存
router.post('/budget/matomete-settings', isLoggedIn, async (req, res) => {
  const days = Number(req.body.matomete_reminder_days);
  const validDays = Number.isInteger(days) && days >= 1 && days <= 31 ? days : 7;
  const hour = Number(req.body.matomete_reminder_hour);
  const validHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8;

  const groupId = req.session.activeGroupId;
  await MatometeSetting.findOneAndUpdate(
    { group: groupId },
    { reminderDays: validDays, reminderHour: validHour },
    { upsert: true, new: true }
  );

  req.flash('success', 'まとめて入力の催促設定を更新しました');
  res.redirect('/finance/budget');
});

// 予算到達メールの送信時間設定
router.post('/budget/notice-time', isLoggedIn, async (req, res) => {
  const hour = Number(req.body.budget_notice_hour);
  const validHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8;
  const groupId = req.session.activeGroupId;
  await FinanceBudgetNoticeSetting.findOneAndUpdate(
    { group: groupId },
    { noticeHour: validHour },
    { upsert: true, new: true }
  );
  req.flash('success', '予算到達メールの送信時間を更新しました');
  res.redirect('/finance/budget');
});

// 予算到達メールのテスト送信
router.post('/budget/notice-test', isLoggedIn, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.redirect('/finance/budget');
    }
    const groupId = req.session.activeGroupId;
    const objectId = typeof groupId === 'string'
      ? new mongoose.Types.ObjectId(groupId)
      : groupId;
    const group = await Group.findById(objectId).populate('members');
    const memberEmails = (group?.members || [])
      .map(m => m.email)
      .filter(Boolean);
    if (memberEmails.length === 0) {
      req.flash('error', '送信先が見つかりませんでした');
      return res.redirect('/finance/budget');
    }
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const daysInMonth = monthEnd.getDate();
    const dayRate = Math.round((today.getDate() / daysInMonth) * 1000) / 10;
    const yearStr = String(today.getFullYear());

    const budgets = await Budget.find({ group: objectId, year: yearStr }).sort({ display_order: 1 }).lean();
    const budgetMap = new Map(budgets.map(b => [b.expense_item || '未分類', Number(b.budget) || 0]));
    const totalBudget = Array.from(budgetMap.values()).reduce((sum, v) => sum + v, 0);
    const expenseAgg = await Finance.aggregate([
      { $match: { group: objectId, user: req.user._id, cf: '支出', date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: '$expense_item', total: { $sum: '$amount' } } }
    ]);
    const actualMap = new Map(expenseAgg.map(r => [r._id || '未分類', Number(r.total) || 0]));
    const totalActual = Array.from(actualMap.values()).reduce((sum, v) => sum + v, 0);
    const totalRate = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 1000) / 10 : 0;

    const thresholdsBase = Array.isArray(req.user?.financeBudgetNoticeThresholds)
      ? req.user.financeBudgetNoticeThresholds
      : [50, 80, 90];
    const thresholds = Array.from(new Set(
      thresholdsBase
        .map(v => Number(v))
        .filter(v => Number.isInteger(v) && v >= 0 && v <= 100)
        .concat([100])
    ));

    const alerts = budgets
      .map(b => {
        const name = b.expense_item || '未分類';
        const budget = Number(b.budget) || 0;
        const actual = actualMap.get(name) || 0;
        const rate = budget > 0 ? Math.round((actual / budget) * 1000) / 10 : 0;
        const satisfied = thresholds.filter(t => rate >= t);
        if (satisfied.length === 0) return null;
        return {
          targetLabel: name,
          actualRate: rate,
          budget,
          actual,
          over: true,
          threshold: Math.max(...satisfied)
        };
      })
      .filter(Boolean);

    await sendMail({
      to: memberEmails,
      subject: '【家計簿】予算の到達状況（テスト送信）',
      templateName: 'budgetNotice',
      templateData: {
        name: req.user.displayname || req.user.username,
        month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
        dayRate,
        groups: [
          {
            groupName: group?.group_name || 'テストグループ',
            totalRate,
            alerts
          }
        ],
        budgetUrl: `${process.env.BASE_URL || 'http://localhost:3000'}/finance/budget`
      }
    });
    req.flash('success', 'テストメールを送信しました');
    res.redirect('/finance/budget');
  } catch (err) {
    console.error('Budget notice test mail error:', err);
    req.flash('error', 'テストメールの送信に失敗しました');
    res.redirect('/finance/budget');
  }
});

// 年度別の区分候補を取得（新規登録/編集のプルダウン更新用）
router.get('/budget/items', isLoggedIn, async (req, res) => {
  try {
    const requestedGroupId = normalizeIdString(req.query.groupId) || normalizeIdString(req.session.activeGroupId);
    const { availableGroupIds } = await getFinanceEditableGroupsForUser(req.user._id);
    if (!requestedGroupId) {
      return res.status(400).json({ error: 'groupId が不足しています' });
    }
    if (!availableGroupIds.has(requestedGroupId)) {
      return res.status(403).json({ error: 'このグループの候補は取得できません' });
    }
    const fiscalStartMonth = await getGroupFiscalStartMonth(requestedGroupId);
    const targetYear = req.query.year
      ? String(req.query.year)
      : resolveFiscalYearForValue(req.query.date, fiscalStartMonth);
    const {
      ex_cfs,
      in_items,
      dedu_cfs,
      saving_cfs,
      pay_cfs,
      allUsers,
      common_tags
    } = await buildFinanceFormOptions({
      groupId: requestedGroupId,
      year: targetYear,
      userId: req.user?._id
    });

    res.json({
      ex_cfs,
      in_items,
      dedu_cfs,
      saving_cfs,
      pay_cfs,
      users: serializeFinanceUsers(allUsers),
      common_tags
    });
  } catch (err) {
    console.error('❌ 年度別区分取得エラー:', err);
    res.status(500).json({ error: '内部エラーが発生しました' });
  }
});

// 年度予算登録画面の表示
router.post('/budget/setup', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = normalizeIdString(req.session.activeGroupId);
    const requestedGroupId = normalizeIdString(req.body.groupId) || activeGroupId;
    if (!activeGroupId || !requestedGroupId || activeGroupId !== requestedGroupId) {
      req.flash('error', '対象グループの予算設定はできません');
      return res.redirect('/finance/budget');
    }
    const year = resolveBudgetYear(req.body.year, new Date().getFullYear());
    const requestedUserId = normalizeIdString(req.body.userId) || normalizeIdString(req.user._id);

    const { members } = await getFinanceBudgetMembers(activeGroupId);
    const targetMember = members.find((member) => member.id === requestedUserId);
    if (!targetMember) {
      req.flash('error', '対象ユーザーがグループに見つかりません');
      return res.redirect(`/finance/budget?year=${encodeURIComponent(year)}`);
    }

    await seedPersonalBudgetsIfMissing({
      groupId: activeGroupId,
      year,
      members
    });

    let personalExpenseRows = await PersonalBudget.find({
      group: activeGroupId,
      user: requestedUserId,
      year
    }).sort({ display_order: 1 });
    if (personalExpenseRows.length === 0) {
      personalExpenseRows = await Budget.find({ group: activeGroupId, year }).sort({ display_order: 1 });
    }
    const budgetItems = personalExpenseRows.length > 0
      ? sanitizeBudgetRowsForForm(personalExpenseRows, 'expense_item')
      : buildDefaultBudgetRows(ex_cfs, 'expense_item');

    const loadPersonalItems = async (laCf, defaults) => {
      let rows = await PersonalItem.find({
        group: activeGroupId,
        user: requestedUserId,
        la_cf: laCf,
        year
      }).sort({ display_order: 1 });
      if (rows.length === 0) {
        rows = await Items.find({ group: activeGroupId, la_cf: laCf, year }).sort({ display_order: 1 });
      }
      if (rows.length === 0) {
        rows = await Items.find({ group: activeGroupId, la_cf: laCf, year: { $exists: false } }).sort({ display_order: 1 });
      }
      if (rows.length === 0) {
        return buildDefaultBudgetRows(defaults, 'item');
      }
      return sanitizeBudgetRowsForForm(rows, 'item');
    };

    const [incomeItems, deduItems, savingItems] = await Promise.all([
      loadPersonalItems('収入項目', defaultInItems.slice(1)),
      loadPersonalItems('控除項目', defaultDeduCfs.slice(1)),
      loadPersonalItems('貯蓄項目', defaultSavingCfs.slice(1))
    ]);

    res.render('finance/budget', {
      groupId: activeGroupId,
      year,
      userId: requestedUserId,
      targetUserName: targetMember.name,
      budgetItems,
      incomeItems,
      deduItems,
      savingItems
    });
  } catch (err) {
    console.error('❌ /budget/setup でエラー:', err);
    req.flash('error', '個人予算画面の表示に失敗しました');
    res.redirect('/finance/budget');
  }
});

//支出項目、収入・控除・貯蓄項目　予算の保存
router.post('/budget/save', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = normalizeIdString(req.session.activeGroupId);
    const requestedGroupId = normalizeIdString(req.body.groupId) || activeGroupId;
    if (!activeGroupId || !requestedGroupId || activeGroupId !== requestedGroupId) {
      req.flash('error', '対象グループの予算保存はできません');
      return res.redirect('/finance/budget');
    }
    const year = resolveBudgetYear(req.body.year, new Date().getFullYear());
    const targetUserId = normalizeIdString(req.body.userId) || normalizeIdString(req.user._id);
    const { members } = await getFinanceBudgetMembers(activeGroupId);
    if (!members.some((member) => member.id === targetUserId)) {
      req.flash('error', '対象ユーザーがグループに見つかりません');
      return res.redirect(`/finance/budget?year=${encodeURIComponent(year)}`);
    }

    await PersonalBudget.deleteMany({ group: activeGroupId, year, user: targetUserId });
    await PersonalItem.deleteMany({
      group: activeGroupId,
      year,
      user: targetUserId,
      la_cf: { $in: ['収入項目', '控除項目', '貯蓄項目', 'income', 'deduction', 'saving'] }
    });

    const now = new Date();
    const expenseArray = Array.isArray(req.body.items) ? req.body.items : Object.values(req.body.items || {});
    const personalExpenseRows = expenseArray
      .map((row) => sanitizeBudgetRow(row, 'expense_item'))
      .filter(Boolean)
      .map((row, index) => ({
        display_order: row.display_order < 9999 ? row.display_order : index + 1,
        group: activeGroupId,
        user: targetUserId,
        year,
        expense_item: row.expense_item,
        budget: row.budget,
        entry_date: now,
        update_date: now
      }));
    if (personalExpenseRows.length > 0) {
      await PersonalBudget.insertMany(personalExpenseRows);
    }

    const buildPersonalItems = (rowsInput, laCf) => {
      const rows = Array.isArray(rowsInput) ? rowsInput : Object.values(rowsInput || {});
      return rows
        .map((row) => sanitizeBudgetRow(row, 'item'))
        .filter(Boolean)
        .map((row, index) => ({
          display_order: row.display_order < 9999 ? row.display_order : index + 1,
          group: activeGroupId,
          user: targetUserId,
          year,
          la_cf: laCf,
          item: row.item,
          budget: row.budget,
          entry_date: now,
          update_date: now
        }));
    };

    const personalItemRows = [
      ...buildPersonalItems(req.body.incomeItems, '収入項目'),
      ...buildPersonalItems(req.body.deduItems, '控除項目'),
      ...buildPersonalItems(req.body.savingItems, '貯蓄項目')
    ];
    if (personalItemRows.length > 0) {
      await PersonalItem.insertMany(personalItemRows);
    }

    await aggregatePersonalBudgetsToGroup({ groupId: activeGroupId, year });

    req.flash('success', '個人予算を保存し、グループ予算を再計算しました');
    await logAction({ req, action: '保存', target: '個人年度予算' });
    return res.redirect(`/finance/budget?year=${encodeURIComponent(year)}`);
  } catch (err) {
    console.error('❌ /budget/save でエラー:', err);
    req.flash('error', '個人予算の保存に失敗しました');
    return res.redirect('/finance/budget');
  }
});

// 支払い方法登録画面の表示
router.get('/payment-items', isLoggedIn, async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    const paymentItems = await PaymentItem.find({ group: activeGroupId, user: req.user._id }).populate('user').populate('group').sort({ display_order: 1 });
    res.render('finance/paymentItem', { paymentItems });
});

//支払い方法　登録・更新処理
router.post('/payment-items', isLoggedIn, async (req, res) => {
  try {
    const { ids = [], names = [], orders = [], lives = [] } = req.body;

    for (let i = 0; i < names.length; i++) {
      const name = names[i]?.trim();
      const order = parseInt(orders[i], 10);

      // 🛡️ 入力が空ならスキップ（新規追加行など）
      if (!name) continue;

      const update = {
        paymentItem: name,
        display_order: !isNaN(order) ? order : 0,
        isLive: lives.includes(String(i)),
        update_date: new Date()
      };

      if (ids[i]) {
        await PaymentItem.findByIdAndUpdate(ids[i], update);
      } else {
        await PaymentItem.create({
          ...update,
          user: req.user._id,
          group: req.session.activeGroupId,
          entry_date: new Date()
        });
      }
    }

    req.flash('success', '支払い方法を更新しました');
    res.redirect('/finance/payment-items');
  } catch (err) {
    console.error('保存エラー:', err);
    req.flash('error', '保存中にエラーが発生しました');
    res.redirect('/finance/payment-items');
  }
});

// 支払い方法の削除
router.delete('/payment-items/:id', isLoggedIn, async (req, res) => {
  await PaymentItem.findByIdAndDelete(req.params.id);
  req.flash('success', '支払い方法を削除しました');
  res.redirect('/finance/payment-items');
});

//新規レシートから家計簿登録の流れ
//レシート読み取り、結果表示の画面（OCR+GPT補正対応）
router.get('/receipt/new', isLoggedIn, upload.single('receiptImage'), async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }
    const fiscalStartMonth = await getGroupFiscalStartMonth(activeGroupId);
    const yearForItems = getCurrentFiscalYear(fiscalStartMonth);
    await loadCfItems(req, yearForItems, fiscalStartMonth);
    const currentUser = await FinanceUser.findById(req.user._id).populate('groups');
    const allUsers = await FinanceUser.find({ groups: req.session.activeGroupId });

    let ocrData = { storeName: '', date: '', tags: [] };
    if (req.file && req.file.path) {
        let filePath = req.file.path;
        const convertedPath = await convertHeicToJpeg(filePath);
        if (convertedPath) filePath = convertedPath;

        try {
            const [result] = await getVisionClient().textDetection(filePath);
            const ocrText = result.textAnnotations[0]?.description || '';
            const corrected = await correctOcrText(ocrText);
            let gptCorrected = {
                storeName: corrected?.storeName || '',
                amount: corrected?.amount?.replace(/[^\d]/g, '') || '',
                date: corrected?.date?.replace(/\//g, '-').replace(/(\d{4})-(\d{1,2})-(\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`) || '',
                tags: (corrected?.tags || []).map(tag => ({
                    name: tag.name,
                    category: tag.category || '',
                    gptCategory: tag.gptCategory || '',
                    price: Number(tag.price) || 0
                }))
            };

            // タグを支出区分別に整理
            const grouped = {};
            for (const tag of gptCorrected.tags) {
                const key = tag.category || '未分類';
                if (!grouped[key]) grouped[key] = { category: key, tags: [], amount: 0 };
                grouped[key].tags.push(tag);
                grouped[key].amount += tag.price;
            }

            ocrData = {
                storeName: gptCorrected.storeName,
                date: gptCorrected.date,
                tagGroups: Object.values(grouped)
            };
            // console.log('✅ OCR結果:', ocrData);
            fs.unlink(filePath, () => {});
        } catch (err) {
            console.error('❌ レシートOCR処理失敗:', err);
        }
    }

    res.render('receipt/new', {
        page: 'receipt',
        currentUser,
        activeGroupId,
        allUsers,
        pay_cfs: global.pay_cfs,
        la_cfs,
        ocrData,
        memo: ''
    });
});

// OCR処理ルート (Google Cloud Vision API)
router.post('/ocrNew', upload.single('receiptImage'), async (req, res) => {
  if (!req.file || !req.file.path) {
    console.error('❌ ファイルがアップロードされていません');
    return res.status(400).json({ error: 'レシート画像が見つかりません' });
  }

  let filePath = req.file.path;

  // 🔄 HEIC画像をJPEGに変換
  const convertedPath = await convertHeicToJpeg(filePath);
  if (!convertedPath) {
    return res.status(500).send('画像の変換に失敗しました');
  }
  filePath = convertedPath;

  try {
    const [result] = await getVisionClient().textDetection(filePath);
    const ocrText = result.textAnnotations[0]?.description || '';

    // GPTで補正された結果を取得
    const corrected = await correctOcrText(ocrText);

    // 補正結果の詳細ログ
    if (corrected) {
      // 明示的に文字列変換
      corrected.amount = String(corrected.amount ?? '');
      corrected.date = String(corrected.date ?? '');
      const { storeName, amount, date } = corrected;
      if (!storeName || !amount || !date) {
        console.warn('⚠️ GPT補正の結果のうち、欠落データがあります:', {
          storeName,
          amount,
          date
        });
      }
    }

    // --- Clean up date and amount for response ---
    // gptCorrected assignment first
    let gptCorrected = {
      storeName: corrected?.storeName,
      amount: corrected?.amount,
      date: corrected?.date,
      tags: corrected?.tags || []
    };
    // Format date to YYYY-MM-DD if it contains slashes
    if (typeof gptCorrected.date === 'string' && gptCorrected.date.includes('/')) {
      const [y, m, d] = gptCorrected.date.split('/');
      if (y && m && d) {
        gptCorrected.date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
    }
    // Clean up amount to retain only digits
    if (typeof gptCorrected.amount === 'string') {
      gptCorrected.amount = gptCorrected.amount.replace(/[^\d]/g, '');
    }
    // --- normalizedTags: 新しい仕様 ---
    // 正常なタグデータをオブジェクトのまま保持する
    const normalizedTags = (gptCorrected.tags || []).map(tag => ({
      name: tag.name,
      category: tag.category || '',
      gptCategory: tag.gptCategory || '',
      price: Number(tag.price) || 0
    }));

    // correctedが有効なオブジェクトかチェックし、OCRLog保存
    if (
      corrected &&
      corrected.storeName &&
      typeof corrected.amount === 'string' &&
      corrected.amount.trim() !== '' &&
      typeof corrected.date === 'string' &&
      corrected.date.trim() !== ''
    ) {
      await OCRLog.create({
        content: ocrText,
        extracted: {
          storeName: corrected.storeName,
          amount: corrected.amount,
          date: corrected.date
        },
        corrected: {
          storeName: gptCorrected.storeName,
          amount: gptCorrected.amount,
          date: gptCorrected.date,
          tags: normalizedTags
        },
        createdAt: new Date()
      });
    } else {
      console.warn("⚠️ OCRログに必要な情報が欠けています。保存をスキップします。", {
        fullText: ocrText,
        ...corrected
      });
      // req.flash('error', 'GPTの1日のトークン制限を超えました。お手数ですが明日再度入力してください');
      // return res.redirect('/finance/list');
    }

    fs.unlink(filePath, () => {}); // 後始末

    // クライアント側でタグを表示させるために tags を HTML へ挿入
    res.locals.tags = gptCorrected.tags;

    const readableTags = normalizedTags.map(tag => {
      const name = tag.name || '';
      const category = tag.category ? `( ${tag.category} )` : '';
      const price = typeof tag.price === 'number' ? ` - ¥${tag.price}` : '';
      return `${name}${category}${price}`;
    });

    res.json({
      success: true,
      storeName: gptCorrected.storeName,
      amount: gptCorrected.amount,
      date: gptCorrected.date,
      tags: normalizedTags // 新たに追加した整形済みタグ文字列
    });

  } catch (err) {
    console.error('❌ OCR処理に失敗:', err);
    fs.unlink(filePath, () => {});
    res.status(500).send('OCRに失敗しました');
  }
});

//OCR結果を受けて新規登録処理（POST /receipt/create）
router.post('/receipt/create', isLoggedIn, async (req, res) => {
  try {
    const userId = req.user._id;
    const groupId = req.session.activeGroupId;

    // 新しい仕様: tags配列を受け取り、categoryでグループ化
    const {
      date,
      cf = '支出',
      storeName,
      payment_type,
      tags = [],
      memo
    } = req.body;

    // --- Extract month and day from date ---
    const jsDate = new Date(date);
    const month = jsDate.getMonth() + 1;
    const day = jsDate.getDate();

    // tagsがJSON文字列の場合はパース
    let parsedTags = tags;
    if (typeof tags === 'string') {
      try {
        parsedTags = JSON.parse(tags);
      } catch (e) {
        parsedTags = [];
      }
    }
    // parsedTagsがオブジェクト1個なら配列化
    if (parsedTags && !Array.isArray(parsedTags)) {
      parsedTags = [parsedTags];
    }

    // カテゴリごとにグループ化
    const groupedTags = {};
    for (const tag of parsedTags || []) {
      const category = tag.category || '未分類';
      if (!groupedTags[category]) {
        groupedTags[category] = {
          category,
          amount: 0,
          tags: []
        };
      }
      groupedTags[category].tags.push(tag);
      groupedTags[category].amount += Number(tag.price || 0);
    }
    const tagGroups = Object.values(groupedTags);

    // 追加: リクエストボディとtagGroupsのログ
    // console.log('✅ OCR新規登録リクエスト:', req.body);
    // console.log('✅ tagGroups:', tagGroups);

    const entries = [];

    for (const group of tagGroups) {
      const { category, amount, tags = [] } = group;

      // 追加: 各カテゴリ・タグの処理ログ
      // console.log('➡️ 登録処理: カテゴリ:', category, ' 金額:', amount);
      // console.log('➡️ 登録処理: タグ:', tags);

      const newFinance = new Finance({
        date,
        cf,
        content: storeName,
        expense_item: category,
        amount: Number(amount),
        payment_type,
        month,
        day,
        user: new mongoose.Types.ObjectId(req.user._id),
        group: groupId,
        tags: tags.map(tag => ({
          name: tag.name,
          category: tag.category,
          price: Number(tag.price || 0)
        })),
        entry_date: new Date(),
        memo: memo || ''
      });
      // 追加: newFinance準備完了ログ
      // console.log('✅ newFinance 準備完了:', newFinance);
      // newFinance.save() を try-catch でラップしてエラー出力
      entries.push(
        (async () => {
          try {
            return await newFinance.save();
          } catch (err) {
            console.error('❌ newFinance保存エラー:', err);
            throw err;
          }
        })()
      );
    }

    const results = await Promise.allSettled(entries);
    // 保存件数をカウント
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    if (successCount === 0) {
      req.flash('error', 'レシート支出の保存に失敗しました。内容を確認してください。');
      return res.redirect('/finance/receipt/new');
    }
    req.flash('success', 'レシート支出が登録されました');
    res.redirect('/finance/list');
  } catch (err) {
    console.error('レシート保存エラー:', err);

    if (err.code === 'insufficient_quota' || (err.error && err.error.code === 'insufficient_quota')) {
      req.flash('error', 'GPTの1日のトークン制限を超えました。お手数ですが明日再度入力してください');
      return res.redirect('/finance/list');
    }

    req.flash('error', 'レシート支出の保存中にエラーが発生しました');
    res.redirect('/finance/receipt/new');
  }
});

module.exports = router;
