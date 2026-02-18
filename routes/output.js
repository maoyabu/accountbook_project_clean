const express = require('express');
const router = express.Router();
const catchAsync = require('../Utils/catchAsync');
const Finance = require('../models/finance');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const methodOverride = require('method-override');
const FinanceUser = require('../models/users');
const FinanceExBudget = require('../models/finance_ex_budget');
const Group = require('../models/groups');
const dashboardController = require('../controllers/dashboardController');
const Items = require('../models/finance_items');
const PaymentItem = require('../models/paymentItems');
const {
  normalizeFiscalStartMonth,
  getFiscalYearForDate,
  getFiscalYearRange,
  getFiscalMonths,
  getFiscalMonthIndex
} = require('../Utils/fiscalYear');

const xlsx = require('xlsx');
const ExcelJS = require('exceljs');
const { isLoggedIn, logAction } = require('../middleware');

async function fetchItemsByYear(groupId, year) {
    const yearStr = String(year);
    let items = await Items.find({ group: groupId, year: yearStr });
    if (items.length === 0) {
        items = await Items.find({ group: groupId, year: { $exists: false } });
    }
    return items;
}

const parseJstDateStart = (value) => {
    if (!value) return null;
    const dt = new Date(`${value}T00:00:00+09:00`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
};

const parseJstDateEnd = (value) => {
    if (!value) return null;
    const dt = new Date(`${value}T23:59:59.999+09:00`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
};

const JST_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', day: 'numeric' });
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

const normalizeCategoryName = (value) => String(value || '').replace(/\s+/g, '').replace(/　/g, '').trim();

const isFoodOrSeasoningExpense = (expenseItem) => {
  const normalized = normalizeCategoryName(expenseItem);
  if (!normalized) return false;
  if (normalized.includes('調味料')) return true;
  return /副食|主食|外食|食費|給食/.test(normalized);
};

const getJstDay = (value) => {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  const day = Number(JST_DAY_FORMATTER.format(dt));
  return Number.isInteger(day) ? day : null;
};

const createCalendarBucket = () => ({
  contents: [],
  contentText: '',
  amount: 0
});

const createCalendarDayRow = (year, month, day) => ({
  day,
  weekday: WEEKDAY_JA[new Date(year, month - 1, day).getDay()],
  income: createCalendarBucket(),
  deduction: createCalendarBucket(),
  foodSeasoning: createCalendarBucket(),
  otherExpense: createCalendarBucket()
});

const getEntryLabel = (entry, fallbackField) => {
  const content = String(entry?.content || '').trim();
  if (content) {
    return content.replace(/\s+/g, ' ');
  }
  const fallback = String(entry?.[fallbackField] || '').trim();
  return fallback;
};

const addEntryToBucket = (bucket, entry, fallbackField) => {
  const amount = Number(entry?.amount) || 0;
  bucket.amount += amount;
  const label = getEntryLabel(entry, fallbackField);
  if (label) {
    bucket.contents.push(label);
  }
};

const finalizeCalendarBucket = (bucket) => {
  const seen = new Set();
  const ordered = [];
  for (const raw of bucket.contents) {
    const text = String(raw || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    ordered.push(text);
  }
  bucket.contentText = ordered.join(', ');
  return bucket;
};

const summarizeCalendarRows = (rows) => {
  const summary = rows.reduce((acc, row) => {
    acc.incomeAmount += row.income.amount;
    acc.deductionAmount += row.deduction.amount;
    acc.foodSeasoningAmount += row.foodSeasoning.amount;
    acc.otherExpenseAmount += row.otherExpense.amount;
    return acc;
  }, {
    incomeAmount: 0,
    deductionAmount: 0,
    foodSeasoningAmount: 0,
    otherExpenseAmount: 0,
    balance: 0
  });

  summary.balance =
    summary.incomeAmount
    - summary.deductionAmount
    - summary.foodSeasoningAmount
    - summary.otherExpenseAmount;

  return summary;
};

function getBudgetMonthCount(targetYear, startMonth = 1, baseDate = new Date()) {
    const currentFiscalYear = getFiscalYearForDate(baseDate, startMonth) ?? baseDate.getFullYear();
    if (targetYear === currentFiscalYear) {
        const monthIndex = getFiscalMonthIndex(baseDate.getMonth() + 1, startMonth);
        return (monthIndex ?? 0) + 1;
    }
    if (targetYear < currentFiscalYear) {
        return 12;
    }
    return 12;
}

async function getGroupFiscalStartMonth(groupId) {
    if (!groupId) return 1;
    const group = await Group.findById(groupId).select('financeFiscalStartMonth');
    return normalizeFiscalStartMonth(group?.financeFiscalStartMonth);
}

//formのリクエストが来たときにパースしてreq.bodyに入れてくれる
router.use(express.urlencoded({ extended: true }));
router.use(methodOverride('_method'));

//export画面の表示
router.get('/view', isLoggedIn, catchAsync(async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }

    const allUsers = await FinanceUser.find({ groups: activeGroupId });

    res.render('export', {
        page: 'export',
        allUsers,
        activeGroupId
    });
}));

//件数カウント用のルート
router.get('/count', isLoggedIn, catchAsync(async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        return res.status(400).json({ error: 'アクティブなグループが選択されていません' });
    }

    const { year, from, to, user } = req.query;

    const filter = { group: activeGroupId };

    if (year) {
        const start = new Date(`${year}-01-01`);
        const end = new Date(`${parseInt(year) + 1}-01-01`);
        filter.date = { $gte: start, $lt: end };
    } else if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = new Date(from);
        if (to) filter.date.$lte = new Date(to);
    }

    if (user) {
        if (mongoose.Types.ObjectId.isValid(user)) {
            filter.user = new mongoose.Types.ObjectId(user);
        } else {
            return res.status(400).json({ error: '無効なユーザーIDです' });
        }
    }

    const count = await Finance.countDocuments(filter);

    // キャッシュを無効化
    res.set('Cache-Control', 'no-store');

    res.json({ count });
}));

// エクスポート用のエンドポイント
router.get('/', isLoggedIn, catchAsync(async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }
  
    const { year, from, to, user } = req.query;
    const filter = { group: activeGroupId };

    if (year) {
      const start = new Date(`${year}-01-01`);
      const end = new Date(`${parseInt(year) + 1}-01-01`);
      filter.date = { $gte: start, $lt: end };
    } else if (from || to) {
      filter.date = {};
      if (from) {
        const startDate = new Date(from);
        startDate.setHours(0, 0, 0, 0);
        filter.date.$gte = startDate;
    }
    if (to) {
        const endDate = new Date(to);
        endDate.setHours(23, 59, 59, 999);
        filter.date.$lte = endDate;
    }
    }
  
    if (user) {
      filter.user = user;
    }

    const finances = await Finance.find(filter)
      .populate('user')
      .sort({ date: 1 });

    const columns = [
      { header: '日付', key: 'date' },
      { header: '月', key: 'month' },
      { header: '日', key: 'day' },
      { header: '区分', key: 'cf' },
      { header: '収入項目', key: 'income_item' },
      { header: '支出項目', key: 'expense_item' },
      { header: '控除項目', key: 'dedu_item' },
      { header: '貯蓄項目', key: 'saving_item' },
      { header: '内容', key: 'content' },
      { header: '金額', key: 'amount' },
      { header: '支払種別', key: 'payment_type' },
      { header: '使用者', key: 'user' },
      { header: 'no', key: 'id' }
    ];

    const rows = finances.map(item => ({
      date: item.date,
      month: item.month,
      day: item.day,
      cf: item.cf,
      income_item: item.income_item,
      expense_item: item.expense_item,
      dedu_item: item.dedu_item,
      saving_item: item.saving_item,
      content: item.content,
      amount: item.amount,
      payment_type: item.payment_type,
      user: item.user?.displayname || '',
      id: item._id.toString()
    }));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Finance Data', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    sheet.columns = columns;
    sheet.addRows(rows);
    sheet.getColumn(1).numFmt = 'yyyy-mm-dd';

    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '006400' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    });

    const lastCol = (() => {
      let n = columns.length;
      let s = '';
      while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    })();
    sheet.autoFilter = { from: 'A1', to: `${lastCol}1` };

    sheet.columns.forEach((col) => {
      let maxLen = String(col.header || '').length;
      col.eachCell({ includeEmpty: true }, (cell, rowNumber) => {
        if (rowNumber === 1) return;
        let text = cell.value;
        if (text == null) return;
        if (text instanceof Date) text = text.toISOString().slice(0, 10);
        if (typeof text === 'object' && text.text) text = text.text;
        maxLen = Math.max(maxLen, String(text).length);
      });
      col.width = Math.min(Math.max(maxLen + 2, 10), 60);
    });

    // ファイル名と保存場所の指定
    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const formattedTime = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    // const homedir = require('os').homedir();
    // const outputPath = path.join(homedir, 'Downloads', `exported_data_${formattedDate}_${formattedTime}.xlsx`);
    const outputDir = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(require('os').homedir(), 'Downloads');
    const outputPath = path.join(outputDir, `exported_data_${formattedDate}_${formattedTime}.xlsx`);

    // Excelファイルとして保存
    await workbook.xlsx.writeFile(outputPath);

    // エクスポート完了後にダウンロードリンクを送信
    res.download(outputPath, `exported_data_${formattedDate}_${formattedTime}.xlsx`, (err) => {
        if (err) {
            console.error('エラー:', err);
            res.status(500).send('エクスポートに失敗しました');
        }
    });
    await logAction({ req, action: 'EXCELファイルの出力', target: '家計簿' });  
    req.flash('success', 'ファイルのエクスポートに成功しました');
}));

// 月別のDashboard表示のルート（個人）
router.get('/dashboard/monthly-m', isLoggedIn, async (req, res) => {
  let year, month;
  if (req.query.ym) {
    const [y, m] = req.query.ym.split('-');
    year = parseInt(y);
    month = parseInt(m);
  } else {
    year = new Date().getFullYear();
    month = new Date().getMonth() + 1;
  }

  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const userId = req.user._id;
  const groupId = req.session.activeGroupId;
  const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
  const fiscalYear = getFiscalYearForDate(start, fiscalStartMonth) ?? year;
  const fiscalRange = getFiscalYearRange(fiscalYear, fiscalStartMonth);
  const fiscalRangeLabel = `${fiscalRange.start.getFullYear()}年${fiscalRange.start.getMonth() + 1}月〜${fiscalRange.endInclusive.getFullYear()}年${fiscalRange.endInclusive.getMonth() + 1}月`;
  const fiscalMonthIndex = (getFiscalMonthIndex(month, fiscalStartMonth) ?? 0) + 1;

  const finances = await Finance.find({
    user: userId,
    group: groupId,
    date: { $gte: start, $lt: end }
  });

  let totalIncome = 0, totalExpense = 0, totalSaving = 0;
  let expenseSummary = {};

  for (let f of finances) {
    if (f.cf === '収入') totalIncome += f.amount;
    else if (f.cf === '貯蓄') totalSaving += f.amount;
    else if (f.cf === '支出' || f.cf === '控除') {
      totalExpense += f.amount;
      const item = f.expense_item || '未分類';
      expenseSummary[item] = (expenseSummary[item] || 0) + f.amount;
    }
  }

  const budgets = await FinanceExBudget.find({ group: groupId, year: String(fiscalYear) });
  const budgetMap = {};
  for (let b of budgets) {
    budgetMap[b.expense_item] = b.budget || 0;
  }

  const expenseItems = Object.keys(budgetMap)
    .map(item => {
      const matched = budgets.find(b => b.expense_item === item);
      const order = matched?.display_order || 9999;
      const total = expenseSummary[item] || 0;
      const budget = budgetMap[item];
      return {
        item,
        total,
        budget,
        diff: budget - total,
        display_order: order
      };
    })
    .sort((a, b) => a.display_order - b.display_order);

  // === 累計集計: 年度開始月から年度末まで ===
  const startOfYear = fiscalRange.start;
  const endOfCurrentMonth = fiscalRange.endInclusive;

  const cumulativeFinances = await Finance.find({
    user: userId,
    group: groupId,
    date: { $gte: startOfYear, $lte: endOfCurrentMonth }
  });

  let cumulativeSummary = {};
  for (let f of cumulativeFinances) {
    if (f.cf === '支出' || f.cf === '控除') {
      const item = f.expense_item || '未分類';
      cumulativeSummary[item] = (cumulativeSummary[item] || 0) + f.amount;
    }
  }

  const cumulativeItems = Object.keys(budgetMap).map(item => {
    const total = cumulativeSummary[item] || 0;
    const monthlyBudget = budgetMap[item];
    const budget = monthlyBudget * 12;
    return {
      item,
      total,
      budget,
      diff: budget - total
    };
  });

  res.render('dashboard/monthly', {
    year, month,
    totalIncome,
    totalExpense,
    totalSaving,
    balance: totalIncome - totalExpense - totalSaving,
    expenseItems,
    cumulativeItems,
    formAction: '/export/dashboard/monthly-m',
    titlePrefix: `${req.user.displayname}さん`,
    viewType: 'user',
    fiscalStartMonth,
    fiscalRangeLabel,
    fiscalYear
  });
});

// 月次カレンダー集計（個人）
router.get('/dashboard/monthly-calendar-m', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;

    if (typeof req.query.ym === 'string') {
      const matched = req.query.ym.match(/^(\d{4})-(\d{1,2})$/);
      if (matched) {
        const parsedYear = Number(matched[1]);
        const parsedMonth = Number(matched[2]);
        if (Number.isInteger(parsedYear) && parsedMonth >= 1 && parsedMonth <= 12) {
          year = parsedYear;
          month = parsedMonth;
        }
      }
    }

    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 1, 0, 0, 0, 0);
    const daysInMonth = new Date(year, month, 0).getDate();

    const finances = await Finance.find({
      user: req.user._id,
      group: groupId,
      date: { $gte: start, $lt: end }
    })
      .select('date day cf content amount income_item dedu_item expense_item')
      .lean();

    const dayRows = Array.from(
      { length: daysInMonth },
      (_, idx) => createCalendarDayRow(year, month, idx + 1)
    );

    for (const entry of finances) {
      const dayFromDate = getJstDay(entry.date);
      const day = Number.isInteger(dayFromDate) ? dayFromDate : Number(entry.day);
      if (!Number.isInteger(day) || day < 1 || day > daysInMonth) continue;
      const row = dayRows[day - 1];

      if (entry.cf === '収入') {
        addEntryToBucket(row.income, entry, 'income_item');
      } else if (entry.cf === '控除') {
        addEntryToBucket(row.deduction, entry, 'dedu_item');
      } else if (entry.cf === '支出') {
        if (isFoodOrSeasoningExpense(entry.expense_item)) {
          addEntryToBucket(row.foodSeasoning, entry, 'expense_item');
        } else {
          addEntryToBucket(row.otherExpense, entry, 'expense_item');
        }
      }
    }

    dayRows.forEach((row) => {
      finalizeCalendarBucket(row.income);
      finalizeCalendarBucket(row.deduction);
      finalizeCalendarBucket(row.foodSeasoning);
      finalizeCalendarBucket(row.otherExpense);
    });

    const subtotal = summarizeCalendarRows(dayRows.filter((row) => row.day <= 15));
    const total = summarizeCalendarRows(dayRows);
    const todayJst = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).format(new Date());

    res.render('dashboard/monthlyCalendar', {
      year,
      month,
      ymValue: `${year}-${String(month).padStart(2, '0')}`,
      titlePrefix: `${req.user.displayname}さん`,
      formAction: '/export/dashboard/monthly-calendar-m',
      dayRows,
      subtotal,
      total,
      todayJst,
      mainClass: 'container-fluid dashboard-calendar-main'
    });
  } catch (err) {
    console.error('❌ 月次カレンダー集計ルートエラー:', err);
    res.status(500).send('月次カレンダー集計エラー');
  }
});

//月別のDashboard表示のルート（グループ）
router.get('/dashboard/monthly-g', isLoggedIn, async (req, res) => {
  let year, month;
  if (req.query.ym) {
    const [y, m] = req.query.ym.split('-');
    year = parseInt(y);
    month = parseInt(m);
  } else {
    year = new Date().getFullYear();
    month = new Date().getMonth() + 1;
  }

  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

  const groupId = req.session.activeGroupId;
  const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
  const fiscalYear = getFiscalYearForDate(start, fiscalStartMonth) ?? year;
  const fiscalRange = getFiscalYearRange(fiscalYear, fiscalStartMonth);
  const fiscalRangeLabel = `${fiscalRange.start.getFullYear()}年${fiscalRange.start.getMonth() + 1}月〜${fiscalRange.endInclusive.getFullYear()}年${fiscalRange.endInclusive.getMonth() + 1}月`;
  const fiscalMonthIndex = (getFiscalMonthIndex(month, fiscalStartMonth) ?? 0) + 1;

  const finances = await Finance.find({
    group: groupId,
    date: { $gte: start, $lt: end }
  });

  // 集計
  let totalIncome = 0, totalExpense = 0, totalSaving = 0;
  let expenseSummary = {};

  for (let f of finances) {
    if (f.cf === '収入') totalIncome += f.amount;
    else if (f.cf === '貯蓄') totalSaving += f.amount;
    else if (f.cf === '支出' || f.cf === '控除') {
      totalExpense += f.amount;
      const item = f.expense_item || '未分類';
      expenseSummary[item] = (expenseSummary[item] || 0) + f.amount;
    }
  }

  // 予算取得
  const budgets = await FinanceExBudget.find({ group: groupId, year: String(fiscalYear) });
  const budgetMap = {};
  for (let b of budgets) {
    budgetMap[b.expense_item] = b.budget || 0;
  }

  //予算のある項目全てまわす
  const expenseItems = Object.keys(budgetMap)
    .map(item => {
      const matched = budgets.find(b => b.expense_item === item);
      const order = matched?.display_order || 9999;
      const total = expenseSummary[item] || 0;
      const budget = budgetMap[item];
      return {
        item,
        total,
        budget,
        diff: budget - total,
        display_order: order
      };
    })
    .sort((a, b) => a.display_order - b.display_order);

  // === 累計集計: 年度開始月から年度末まで ===
  const startOfYear = fiscalRange.start;
  const endOfCurrentMonth = fiscalRange.endInclusive;

  const cumulativeFinances = await Finance.find({
    group: groupId,
    date: { $gte: startOfYear, $lte: endOfCurrentMonth }
  });

  let cumulativeSummary = {};
  for (let f of cumulativeFinances) {
    if (f.cf === '支出' || f.cf === '控除') {
      const item = f.expense_item || '未分類';
      cumulativeSummary[item] = (cumulativeSummary[item] || 0) + f.amount;
    }
  }

  const cumulativeItems = Object.keys(budgetMap).map(item => {
    const total = cumulativeSummary[item] || 0;
    const monthlyBudget = budgetMap[item];
    const budget = monthlyBudget * 12;
    return {
      item,
      total,
      budget,
      diff: budget - total
    };
  });

  let groupName = 'グループ';
  if (!req.session.groupName) {
    const group = await Group.findById(groupId);
    if (group) {
      groupName = group.group_name;
      req.session.groupName = group.group_name; // 次回以降の表示を高速化
    }
  } else {
    groupName = req.session.groupName;
  }

  res.render('dashboard/monthly', {
    year, month,
    totalIncome,
    totalExpense,
    totalSaving,
    balance: totalIncome - totalExpense - totalSaving,
    expenseItems,
    cumulativeItems,
    formAction: '/export/dashboard/monthly-g',
    titlePrefix: `${groupName}`,
    viewType: 'group',
    fiscalStartMonth,
    fiscalRangeLabel,
    fiscalYear
  });
});

//年間収支実績（個人）
router.get('/dashboard/yearly-m', async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const year = parseInt(req.query.year) || defaultYear;
    const fiscalRange = getFiscalYearRange(year, fiscalStartMonth);
    const fiscalMonths = getFiscalMonths(fiscalStartMonth);
    const monthIndexMap = new Map(fiscalMonths.map((m, idx) => [m, idx + 1]));

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          user: new mongoose.Types.ObjectId(userId),
          date: {
            $gte: fiscalRange.start,
            $lt: fiscalRange.end
          }
        }
      },
      {
        $project: {
          month: { $month: { date: '$date', timezone: 'Asia/Tokyo' } },
          cf: 1,
          amount: 1,
          expense_item: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item'
          },
          total: { $sum: '$amount' }
        }
      },
      {
        $sort: { '_id.month': 1 }
      }
    ]);

    const monthlySummary = {};
    const monthlyExpensesDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item } = r._id;
      const fiscalMonth = monthIndexMap.get(month);
      if (!fiscalMonth) return;
      const total = r.total;
      if (!monthlySummary[fiscalMonth][cf]) monthlySummary[fiscalMonth][cf] = 0;
      monthlySummary[fiscalMonth][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[fiscalMonth][expense_item]) {
          monthlyExpensesDetail[fiscalMonth][expense_item] = 0;
        }
        monthlyExpensesDetail[fiscalMonth][expense_item] += total;
      }
    });
    // Dynamically build ex_cfs from budget items
    const budgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    const budgetMap = {};
    const ex_cfs = [];
    for (let b of budgets) {
      budgetMap[b.expense_item] = b.budget || 0;
      if (b.expense_item && !ex_cfs.includes(b.expense_item)) {
        ex_cfs.push(b.expense_item);
      }
    }
    // 並び順: 予算設定の display_order を優先
    const orderMap_m = Object.fromEntries(budgets.map(b => [b.expense_item, (b.display_order ?? 9999)]));
    ex_cfs.sort((a, b) => (orderMap_m[a] ?? 9999) - (orderMap_m[b] ?? 9999));

    // === 累計予算計算: 現在月までの累計予算を計算 ===
    const budgetMonthCount = getBudgetMonthCount(year, fiscalStartMonth, new Date());
    const cumulativeBudgetMap = {};
    for (let [item, monthlyBudget] of Object.entries(budgetMap)) {
      // 貯蓄は対象年が現在年度なら現在月まで、過去年なら12ヶ月分
      if (item === '貯蓄') {
        const targetMonth = year === (getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear())
          ? budgetMonthCount
          : 12;
        cumulativeBudgetMap[item] = monthlyBudget * targetMonth;
      } else {
        cumulativeBudgetMap[item] = monthlyBudget * budgetMonthCount;
      }
    }

    // 追加: Itemsモデルからgroup一致のデータを取得し、各カテゴリ合計を算出
    const totalBudgets = {
      収入: 0,
      貯蓄: 0,
      控除: 0,
      支出: 0
    };
    // la_cfを正規化するマップ
    const cfMap = {
      '収入項目': '収入',
      '貯蓄項目': '貯蓄',
      '控除項目': '控除',
      '支出項目': '支出'
    };
    const items = await fetchItemsByYear(groupId, year);
    for (const i of items) {
      const cfKey = cfMap[i.la_cf];
      if (cfKey && cfKey !== '支出' && totalBudgets[cfKey] !== undefined) {
        totalBudgets[cfKey] += i.budget;
      }
    }
    const exBudgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
    }

    const firstYear = 2022;
    const lastYear = defaultYear;
    const availableYears = Array.from({ length: Math.max(lastYear - firstYear + 1, 1) }, (_, i) => firstYear + i);
    if (!availableYears.includes(year)) {
      availableYears.push(year);
      availableYears.sort((a, b) => a - b);
    }

    res.render('dashboard/yearly', {
      year,
      monthlySummary,
      monthlyExpensesDetail,
      budgetMap,
      cumulativeBudgetMap,
      ex_cfs,
      formAction: '/export/dashboard/yearly-m',
      titlePrefix: `${req.user.displayname}さん`,
      viewType: 'user',
      totalBudgets,
      mainClass: 'container-fluid dashboard-yearly-main',
      fiscalMonths,
      budgetMonthCount,
      availableYears
    });

  } catch (err) {
    console.error('❌ 年次集計ルートエラー:', err);
    res.status(500).send('年次集計エラー');
  }
});

//年間収支実績（グループ）
router.get('/dashboard/yearly-g', async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const year = parseInt(req.query.year) || defaultYear;
    const fiscalRange = getFiscalYearRange(year, fiscalStartMonth);
    const fiscalMonths = getFiscalMonths(fiscalStartMonth);
    const monthIndexMap = new Map(fiscalMonths.map((m, idx) => [m, idx + 1]));

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          date: {
            $gte: fiscalRange.start,
            $lt: fiscalRange.end
          }
        }
      },
      {
        $project: {
          month: { $month: { date: '$date', timezone: 'Asia/Tokyo' } },
          cf: 1,
          amount: 1,
          expense_item: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item'
          },
          total: { $sum: '$amount' }
        }
      },
      {
        $sort: { '_id.month': 1 }
      }
    ]);

    const monthlySummary = {};
    const monthlyExpensesDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item } = r._id;
      const fiscalMonth = monthIndexMap.get(month);
      if (!fiscalMonth) return;
      const total = r.total;
      if (!monthlySummary[fiscalMonth][cf]) monthlySummary[fiscalMonth][cf] = 0;
      monthlySummary[fiscalMonth][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[fiscalMonth][expense_item]) {
          monthlyExpensesDetail[fiscalMonth][expense_item] = 0;
        }
        monthlyExpensesDetail[fiscalMonth][expense_item] += total;
      }
    });

    const budgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    const budgetMap = {};
    const ex_cfs = [];
    for (let b of budgets) {
      budgetMap[b.expense_item] = b.budget || 0;
      if (b.expense_item && !ex_cfs.includes(b.expense_item)) {
        ex_cfs.push(b.expense_item);
      }
    }
    const orderMap_g = Object.fromEntries(budgets.map(b => [b.expense_item, (b.display_order ?? 9999)]));
    ex_cfs.sort((a, b) => (orderMap_g[a] ?? 9999) - (orderMap_g[b] ?? 9999));

    // === 累計予算計算: 現在月までの累計予算を計算 ===
    const budgetMonthCount = getBudgetMonthCount(year, fiscalStartMonth, new Date());
    const cumulativeBudgetMap = {};
    for (let [item, monthlyBudget] of Object.entries(budgetMap)) {
      if (item === '貯蓄') {
        const targetMonth = year === (getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear())
          ? budgetMonthCount
          : 12;
        cumulativeBudgetMap[item] = monthlyBudget * targetMonth;
      } else {
        cumulativeBudgetMap[item] = monthlyBudget * budgetMonthCount;
      }
    }

    // 追加: Itemsモデルからgroup一致のデータを取得し、各カテゴリ合計を算出
    const items = await fetchItemsByYear(groupId, year);
    const totalBudgets = {
      収入: 0,
      貯蓄: 0,
      控除: 0,
      支出: 0
    };
    // la_cfを正規化するマップ
    const cfMap = {
      '収入項目': '収入',
      '貯蓄項目': '貯蓄',
      '控除項目': '控除',
      '支出項目': '支出'
    };
    for (const i of items) {
      const cfKey = cfMap[i.la_cf];
      if (cfKey && cfKey !== '支出' && totalBudgets[cfKey] !== undefined) {
        totalBudgets[cfKey] += i.budget;
      }
    }

    const exBudgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
    }
    // console.log(totalBudgets);

    let groupName = 'グループ';
    if (!req.session.groupName) {
      const group = await Group.findById(groupId);
      if (group) {
        groupName = group.group_name;
        req.session.groupName = group.group_name; // 次回以降の表示を高速化
      }
    } else {
      groupName = req.session.groupName;
    }

    const firstYear = 2022;
    const lastYear = defaultYear;
    const availableYears = Array.from({ length: Math.max(lastYear - firstYear + 1, 1) }, (_, i) => firstYear + i);
    if (!availableYears.includes(year)) {
      availableYears.push(year);
      availableYears.sort((a, b) => a - b);
    }

    res.render('dashboard/yearly', {
      year,
      monthlySummary,
      monthlyExpensesDetail,
      budgetMap,
      cumulativeBudgetMap,
      ex_cfs,
      formAction: '/export/dashboard/yearly-g',
      titlePrefix: `${groupName}`,
      viewType: 'group',
      totalBudgets,
      mainClass: 'container-fluid dashboard-yearly-main',
      fiscalMonths,
      budgetMonthCount,
      availableYears
    });

  } catch (err) {
    console.error('❌ 年次集計ルートエラー:', err);
    res.status(500).send('年次集計エラー');
  }
});

//年次集計結果をEXCELで出力（ビューと同じ構成）
router.get('/dashboard/yearly-m-exls', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const year = parseInt(req.query.year) || defaultYear;
    const fiscalRange = getFiscalYearRange(year, fiscalStartMonth);
    const fiscalMonths = getFiscalMonths(fiscalStartMonth);
    const monthIndexMap = new Map(fiscalMonths.map((m, idx) => [m, idx + 1]));

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          user: new mongoose.Types.ObjectId(userId),
          date: {
            $gte: fiscalRange.start,
            $lt: fiscalRange.end
          }
        }
      },
      {
        $project: {
          month: { $month: { date: '$date', timezone: 'Asia/Tokyo' } },
          cf: 1,
          amount: 1,
          expense_item: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item'
          },
          total: { $sum: '$amount' }
        }
      },
      {
        $sort: { '_id.month': 1 }
      }
    ]);

    // 集計
    const monthlySummary = {};
    const monthlyExpensesDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item } = r._id;
      const fiscalMonth = monthIndexMap.get(month);
      if (!fiscalMonth) return;
      const total = r.total;
      if (!monthlySummary[fiscalMonth][cf]) monthlySummary[fiscalMonth][cf] = 0;
      monthlySummary[fiscalMonth][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[fiscalMonth][expense_item]) {
          monthlyExpensesDetail[fiscalMonth][expense_item] = 0;
        }
        monthlyExpensesDetail[fiscalMonth][expense_item] += total;
      }
    });

    const budgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    const budgetMap = {};
    const ex_cfs = [];
    for (let b of budgets) {
      budgetMap[b.expense_item] = b.budget || 0;
      if (b.expense_item && !ex_cfs.includes(b.expense_item)) {
        ex_cfs.push(b.expense_item);
      }
    }
    const orderMap_x = Object.fromEntries(budgets.map(b => [b.expense_item, (b.display_order ?? 9999)]));
    ex_cfs.sort((a, b) => (orderMap_x[a] ?? 9999) - (orderMap_x[b] ?? 9999));

    const cfMap = {
      '収入項目': '収入',
      '貯蓄項目': '貯蓄',
      '控除項目': '控除',
      '支出項目': '支出'
    };
    const totalBudgets = {
      収入: 0,
      貯蓄: 0,
      控除: 0,
      支出: 0
    };
    const budgetItems = await fetchItemsByYear(groupId, year);
    for (const i of budgetItems) {
      const cfKey = cfMap[i.la_cf];
      if (cfKey && cfKey !== '支出') {
        totalBudgets[cfKey] += i.budget || 0;
      }
    }
    const exBudgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
    }

    const data = [];

    const budgetMonthCount = getBudgetMonthCount(year, fiscalStartMonth, new Date());

    // ヘッダー
    const header = ['項目', '予算'];
    fiscalMonths.forEach(m => header.push(`${m}月`));
    header.push('年合計', '', '予算累計', '累計差');
    data.push(header);

    const cfList = ['収入', '貯蓄', '控除', '支出'];
    cfList.forEach(cf => {
      const row = [cf, totalBudgets[cf] || 0];
      let yearTotal = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlySummary[m]?.[cf] || 0;
        row.push(val);
        yearTotal += val;
      }
      const budgetCumulative = (totalBudgets[cf] || 0) * budgetMonthCount;
      const isIncomeOrSaving = cf === '収入' || cf === '貯蓄';
      const diff = isIncomeOrSaving ? yearTotal - budgetCumulative : budgetCumulative - yearTotal;
      row.push(yearTotal, '', budgetCumulative, diff);
      data.push(row);
    });

    // 収支
    const balanceRow = ['収支', ''];
    let yearBalance = 0;
    for (let m = 1; m <= 12; m++) {
      const income = monthlySummary[m]?.['収入'] || 0;
      const save = monthlySummary[m]?.['貯蓄'] || 0;
      const dedu = monthlySummary[m]?.['控除'] || 0;
      const expe = monthlySummary[m]?.['支出'] || 0;
      const b = income - save - dedu - expe;
      balanceRow.push(b);
      yearBalance += b;
    }
    balanceRow.push(yearBalance, '', '', '');
    data.push(balanceRow);

    // 空行
    data.push([]);
    // 支出明細タイトル行
    const detailTitle = '【支出明細】';
    data.push([detailTitle]);

    // 支出内訳
    ex_cfs.forEach(item => {
      const row = [item, budgetMap[item] || 0];
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlyExpensesDetail[m]?.[item] || 0;
        row.push(val);
        total += val;
      }
      const budgetCumulative = (budgetMap[item] || 0) * budgetMonthCount;
      const diff = budgetCumulative - total;
      row.push(total, '', budgetCumulative, diff);
      data.push(row);
    });

    const os = require('os');
    const path = require('path');
    const outputDir = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(os.homedir(), 'Downloads');
    const outputPath = path.join(outputDir, `${year}サマリー.xlsx`);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Yearly Summary', {
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }]
    });

    const columns = data[0].map((header, idx) => ({
      header,
      key: `c${idx}`,
      width: header === '' ? 2.5 : 12
    }));
    sheet.columns = columns;
    data.slice(1).forEach(row => {
      const rowObj = {};
      row.forEach((val, idx) => {
        rowObj[`c${idx}`] = val;
      });
      sheet.addRow(rowObj);
    });

    const headerRow = sheet.getRow(1);
    headerRow.height = 20;
    headerRow.eachCell((cell, colNumber) => {
      if (sheet.getColumn(colNumber).header === '') return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '006400' } };
      cell.font = { name: 'Meiryo UI', size: 14, color: { argb: 'FFFFFFFF' }, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell) => {
        if (!cell.font) {
          cell.font = { name: 'Meiryo UI', size: 14 };
        }
      });
    });

    let itemRowIndex = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemCell = row.getCell(1);
      const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
      const hasItem = itemLabel !== '';
      if (itemLabel === detailTitle) return;
      if (!hasItem) return;
      itemRowIndex += 1;
      if (itemRowIndex % 2 === 1) {
        row.eachCell((cell, colNumber) => {
          if (sheet.getColumn(colNumber).header === '') return;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E6F4EA' } };
        });
      }
    });

    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        if (rowNumber > 1 && typeof cell.value === 'number') {
          cell.numFmt = '#,##0';
        }
      });
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemCell = row.getCell(1);
      const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
      if (itemLabel === detailTitle) {
        itemCell.font = { name: 'Meiryo UI', size: 14, bold: true };
        itemCell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });

    const negativeFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8D7DA' } };
    const negativeFontColor = { argb: '9C0006' };
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell, colNumber) => {
        const itemCell = row.getCell(1);
        const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
        if (itemLabel === detailTitle) return;
        if (sheet.getColumn(colNumber).header === '') return;
        if (typeof cell.value === 'number' && cell.value < 0) {
          cell.fill = negativeFill;
          const baseFont = cell.font || { name: 'Meiryo UI', size: 14 };
          cell.font = { ...baseFont, color: negativeFontColor };
        }
      });
    });

    sheet.columns.forEach((col) => {
      if (col.header === '') return;
      let maxLen = String(col.header || '').length;
      col.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.value == null) return;
        const text = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value);
        maxLen = Math.max(maxLen, text.length);
      });
      col.width = Math.min(Math.max(maxLen + 4, 12), 40);
    });

    const thick = { style: 'thick', color: { argb: 'FF2E2E2E' } };
    const lastCol = sheet.columnCount;
    const summaryRows = cfList.length + 1; // 収入〜収支
    const summaryEndRow = 1 + summaryRows;
    const detailStartRow = summaryEndRow + 3; // 空行+タイトル行の次から
    const detailEndRow = detailStartRow + ex_cfs.length - 1;

    const applyThickBorder = (startRow, endRow) => {
      if (!endRow || endRow < startRow) return;
      for (let r = startRow; r <= endRow; r++) {
        for (let c = 1; c <= lastCol; c++) {
          const cell = sheet.getCell(r, c);
          const border = {};
          if (r === startRow) border.top = thick;
          if (r === endRow) border.bottom = thick;
          if (c === 1) border.left = thick;
          if (c === lastCol) border.right = thick;
          if (Object.keys(border).length > 0) cell.border = border;
        }
      }
    };

    applyThickBorder(1, summaryEndRow);
    applyThickBorder(detailStartRow, detailEndRow);

    sheet.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1
    };

    await workbook.xlsx.writeFile(outputPath);

    res.download(outputPath, `${year}サマリー.xlsx`, (err) => {
      fs.unlink(outputPath, () => {});
      if (err) {
        console.error('❌ 年次Excelダウンロードエラー:', err);
      }
    });
  } catch (err) {
    console.error('❌ 年次Excel出力エラー:', err);
    res.status(500).send('年次Excel出力エラー');
  }
});

//年次集計結果をEXCELで出力（ビューと同じ構成）
router.get('/dashboard/yearly-g-exls', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const year = parseInt(req.query.year) || defaultYear;
    const fiscalRange = getFiscalYearRange(year, fiscalStartMonth);
    const fiscalMonths = getFiscalMonths(fiscalStartMonth);
    const monthIndexMap = new Map(fiscalMonths.map((m, idx) => [m, idx + 1]));

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          date: {
            $gte: fiscalRange.start,
            $lt: fiscalRange.end
          }
        }
      },
      {
        $project: {
          month: { $month: { date: '$date', timezone: 'Asia/Tokyo' } },
          cf: 1,
          amount: 1,
          expense_item: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item'
          },
          total: { $sum: '$amount' }
        }
      },
      {
        $sort: { '_id.month': 1 }
      }
    ]);

    // 集計
    const monthlySummary = {};
    const monthlyExpensesDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item } = r._id;
      const fiscalMonth = monthIndexMap.get(month);
      if (!fiscalMonth) return;
      const total = r.total;
      if (!monthlySummary[fiscalMonth][cf]) monthlySummary[fiscalMonth][cf] = 0;
      monthlySummary[fiscalMonth][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[fiscalMonth][expense_item]) {
          monthlyExpensesDetail[fiscalMonth][expense_item] = 0;
        }
        monthlyExpensesDetail[fiscalMonth][expense_item] += total;
      }
    });

    const budgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    const budgetMap = {};
    const ex_cfs = [];
    for (let b of budgets) {
      budgetMap[b.expense_item] = b.budget || 0;
      if (b.expense_item && !ex_cfs.includes(b.expense_item)) {
        ex_cfs.push(b.expense_item);
      }
    }
    const orderMap_x = Object.fromEntries(budgets.map(b => [b.expense_item, (b.display_order ?? 9999)]));
    ex_cfs.sort((a, b) => (orderMap_x[a] ?? 9999) - (orderMap_x[b] ?? 9999));

    const cfMap = {
      '収入項目': '収入',
      '貯蓄項目': '貯蓄',
      '控除項目': '控除',
      '支出項目': '支出'
    };
    const totalBudgets = {
      収入: 0,
      貯蓄: 0,
      控除: 0,
      支出: 0
    };
    const budgetItems = await fetchItemsByYear(groupId, year);
    for (const i of budgetItems) {
      const cfKey = cfMap[i.la_cf];
      if (cfKey && cfKey !== '支出') {
        totalBudgets[cfKey] += i.budget || 0;
      }
    }
    const exBudgets = await FinanceExBudget.find({ group: groupId, year: String(year) });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
    }

    const data = [];

    const budgetMonthCount = getBudgetMonthCount(year, fiscalStartMonth, new Date());

    // ヘッダー
    const header = ['項目', '予算'];
    fiscalMonths.forEach(m => header.push(`${m}月`));
    header.push('年合計', '', '予算累計', '累計差');
    data.push(header);

    const cfList = ['収入', '貯蓄', '控除', '支出'];
    cfList.forEach(cf => {
      const row = [cf, totalBudgets[cf] || 0];
      let yearTotal = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlySummary[m]?.[cf] || 0;
        row.push(val);
        yearTotal += val;
      }
      const budgetCumulative = (totalBudgets[cf] || 0) * budgetMonthCount;
      const isIncomeOrSaving = cf === '収入' || cf === '貯蓄';
      const diff = isIncomeOrSaving ? yearTotal - budgetCumulative : budgetCumulative - yearTotal;
      row.push(yearTotal, '', budgetCumulative, diff);
      data.push(row);
    });

    // 収支
    const balanceRow = ['収支', ''];
    let yearBalance = 0;
    for (let m = 1; m <= 12; m++) {
      const income = monthlySummary[m]?.['収入'] || 0;
      const save = monthlySummary[m]?.['貯蓄'] || 0;
      const dedu = monthlySummary[m]?.['控除'] || 0;
      const expe = monthlySummary[m]?.['支出'] || 0;
      const b = income - save - dedu - expe;
      balanceRow.push(b);
      yearBalance += b;
    }
    balanceRow.push(yearBalance, '', '', '');
    data.push(balanceRow);

    // 空行
    data.push([]);
    // 支出明細タイトル行
    const detailTitle = '【支出明細】';
    data.push([detailTitle]);

    // 支出内訳
    ex_cfs.forEach(item => {
      const row = [item, budgetMap[item] || 0];
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlyExpensesDetail[m]?.[item] || 0;
        row.push(val);
        total += val;
      }
      const budgetCumulative = (budgetMap[item] || 0) * budgetMonthCount;
      const diff = budgetCumulative - total;
      row.push(total, '', budgetCumulative, diff);
      data.push(row);
    });

    const os = require('os');
    const path = require('path');
    const now = new Date();
    const outputDir = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(os.homedir(), 'Downloads');
    const outputPath = path.join(outputDir, `${year}サマリー.xlsx`);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Yearly Summary', {
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }]
    });

    const columns = data[0].map((header, idx) => ({
      header,
      key: `c${idx}`,
      width: header === '' ? 2.5 : 12
    }));
    sheet.columns = columns;
    data.slice(1).forEach(row => {
      const rowObj = {};
      row.forEach((val, idx) => {
        rowObj[`c${idx}`] = val;
      });
      sheet.addRow(rowObj);
    });

    const headerRow = sheet.getRow(1);
    headerRow.height = 20;
    headerRow.eachCell((cell, colNumber) => {
      if (sheet.getColumn(colNumber).header === '') return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '006400' } };
      cell.font = { name: 'Meiryo UI', size: 14, color: { argb: 'FFFFFFFF' }, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell) => {
        if (!cell.font) {
          cell.font = { name: 'Meiryo UI', size: 14 };
        }
      });
    });

    let itemRowIndex = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemCell = row.getCell(1);
      const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
      const hasItem = itemLabel !== '';
      if (itemLabel === detailTitle) return;
      if (!hasItem) return;
      itemRowIndex += 1;
      if (itemRowIndex % 2 === 1) {
        row.eachCell((cell, colNumber) => {
          if (sheet.getColumn(colNumber).header === '') return;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E6F4EA' } };
        });
      }
    });

    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        if (rowNumber > 1 && typeof cell.value === 'number') {
          cell.numFmt = '#,##0';
        }
      });
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const itemCell = row.getCell(1);
      const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
      if (itemLabel === detailTitle) {
        itemCell.font = { name: 'Meiryo UI', size: 14, bold: true };
        itemCell.alignment = { horizontal: 'left', vertical: 'middle' };
      }
    });

    const negativeFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8D7DA' } };
    const negativeFontColor = { argb: '9C0006' };
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell, colNumber) => {
        const itemCell = row.getCell(1);
        const itemLabel = itemCell.value != null ? String(itemCell.value).trim() : '';
        if (itemLabel === detailTitle) return;
        if (sheet.getColumn(colNumber).header === '') return;
        if (typeof cell.value === 'number' && cell.value < 0) {
          cell.fill = negativeFill;
          const baseFont = cell.font || { name: 'Meiryo UI', size: 14 };
          cell.font = { ...baseFont, color: negativeFontColor };
        }
      });
    });

    sheet.columns.forEach((col) => {
      if (col.header === '') return;
      let maxLen = String(col.header || '').length;
      col.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.value == null) return;
        const text = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : String(cell.value);
        maxLen = Math.max(maxLen, text.length);
      });
      col.width = Math.min(Math.max(maxLen + 4, 12), 40);
    });

    const thick = { style: 'thick', color: { argb: 'FF2E2E2E' } };
    const lastCol = sheet.columnCount;
    const summaryRows = cfList.length + 1; // 収入〜収支
    const summaryEndRow = 1 + summaryRows;
    const detailStartRow = summaryEndRow + 3; // 空行+タイトル行の次から
    const detailEndRow = detailStartRow + ex_cfs.length - 1;

    const applyThickBorder = (startRow, endRow) => {
      if (!endRow || endRow < startRow) return;
      for (let r = startRow; r <= endRow; r++) {
        for (let c = 1; c <= lastCol; c++) {
          const cell = sheet.getCell(r, c);
          const border = {};
          if (r === startRow) border.top = thick;
          if (r === endRow) border.bottom = thick;
          if (c === 1) border.left = thick;
          if (c === lastCol) border.right = thick;
          if (Object.keys(border).length > 0) cell.border = border;
        }
      }
    };

    applyThickBorder(1, summaryEndRow);
    applyThickBorder(detailStartRow, detailEndRow);

    sheet.pageSetup = {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1
    };

    await workbook.xlsx.writeFile(outputPath);

    res.download(outputPath, `${year}サマリー.xlsx`, (err) => {
      fs.unlink(outputPath, () => {});
      if (err) {
        console.error('❌ 年次Excelダウンロードエラー:', err);
      }
    });
  } catch (err) {
    console.error('❌ 年次Excel出力エラー:', err);
    res.status(500).send('年次Excel出力エラー');
  }
});

//支出計
router.get('/monthly-chart', dashboardController.getMonthlyExpenseData);

// 月別支出明細のグラフ表示
router.get('/monthly-stacked', isLoggedIn, catchAsync(async (req, res) => {
  const groupId = new mongoose.Types.ObjectId(req.session.activeGroupId);
  const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
  const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();

  // 利用可能な年を取得（支出データから）
  const yearsRaw = await Finance.aggregate([
    {
      $match: {
        group: groupId,
        cf: '支出',
        date: { $exists: true }
      }
    },
    {
      $project: {
        year: { $year: { date: "$date", timezone: "Asia/Tokyo" } },
        month: { $month: { date: "$date", timezone: "Asia/Tokyo" } }
      }
    },
  ]);
  const yearSet = new Set();
  yearsRaw.forEach((y) => {
    const fiscalYear = y.month >= fiscalStartMonth ? y.year : y.year - 1;
    yearSet.add(fiscalYear);
  });
  const budgetYears = await FinanceExBudget.distinct('year', { group: groupId });
  budgetYears.forEach((y) => {
    const num = Number(y);
    if (Number.isInteger(num)) yearSet.add(num);
  });

  if (yearSet.size === 0) {
    yearSet.add(defaultYear);
  }

  const availableYears = Array.from(yearSet).sort((a, b) => a - b);
  const maxSelectableYears = 3;
  const requestedYearsRaw = req.query.years ?? req.query.year;
  const requestedYears = Array.isArray(requestedYearsRaw)
    ? requestedYearsRaw
    : (requestedYearsRaw ? [requestedYearsRaw] : []);

  let selectedYears = requestedYears
    .map((value) => Number(value))
    .filter((year) => Number.isInteger(year))
    .filter((year, index, arr) => arr.indexOf(year) === index)
    .filter((year) => availableYears.includes(year));

  selectedYears.sort((a, b) => a - b);

  if (selectedYears.length > maxSelectableYears) {
    selectedYears = selectedYears.slice(0, maxSelectableYears);
  }

  if (selectedYears.length === 0) {
    selectedYears = [availableYears.includes(defaultYear) ? defaultYear : availableYears[availableYears.length - 1]];
  }

  // チャート用のデータ生成処理（既存ロジックを再利用）
  let yearlyCharts = [];
  if (dashboardController.generateMonthlyStackedChartData) {
    yearlyCharts = await Promise.all(selectedYears.map(async (targetYear) => {
      const { labels, datasets } = await dashboardController.generateMonthlyStackedChartData(
        groupId,
        targetYear,
        fiscalStartMonth
      );
      return { year: targetYear, labels, datasets };
    }));
  } else if (dashboardController.getMonthlyStackedExpenseData) {
    throw new Error('generateMonthlyStackedChartData関数が必要です。');
  } else {
    throw new Error('グラフ用データ生成関数が見つかりません。');
  }

  const labels = yearlyCharts[0]?.labels || getFiscalMonths(fiscalStartMonth).map((m) => `${m}月`);
  const datasets = [];
  const itemColorMap = new Map();
  yearlyCharts.forEach(({ year, datasets: yearDatasets }) => {
    yearDatasets.forEach((dataset) => {
      const itemKey = dataset.label;
      if (!itemColorMap.has(itemKey)) {
        itemColorMap.set(itemKey, dataset.backgroundColor);
      }
      datasets.push({
        ...dataset,
        label: itemKey,
        itemKey,
        fiscalYear: year,
        stack: String(year),
        backgroundColor: itemColorMap.get(itemKey)
      });
    });
  });

  res.render('dashboard/monthlyStackedChart', {
    labels,
    datasets,
    availableYears,
    selectedYears,
    maxSelectableYears
  });
}));

//年別支出明細のグラフ表示
router.get('/yearly-stacked', dashboardController.getYearlyExpenseData);


// 年次明細（支出内訳セルのドリルダウン表示）
router.get('/dashboard/yearly-detail', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const { year, month, item, scope, cf } = req.query;
    const { from, to, payment_type, user } = req.query;

    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const y = parseInt(year) || defaultYear;
    const m = month ? parseInt(month) : undefined;
    const cfValue = cf || '支出';
    const fiscalRange = getFiscalYearRange(y, fiscalStartMonth);
    const resolvedYearForMonth = m
      ? (m >= fiscalStartMonth ? y : y + 1)
      : null;

    // 日付範囲設定
    let dateFilter = {};
    if (from || to) {
      // 明示的な絞り込みが指定されたらそれを優先
      const start = from
        ? parseJstDateStart(from)
        : (m && m >= 1 && m <= 12 ? new Date(y, m - 1, 1) : fiscalRange.start);
      const end = to
        ? parseJstDateEnd(to)
        : (m && m >= 1 && m <= 12 ? new Date(y, m, 1) : fiscalRange.endInclusive);
      if (!isNaN(start.getTime())) start.setHours(0, 0, 0, 0);
      if (!isNaN(end.getTime())) end.setHours(23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else {
      // 年または年月の範囲
      if (m && m >= 1 && m <= 12) {
        const start = new Date(resolvedYearForMonth, m - 1, 1, 0, 0, 0, 0);
        const end = new Date(resolvedYearForMonth, m, 0, 23, 59, 59, 999);
        dateFilter = { $gte: start, $lte: end };
      } else {
        const start = fiscalRange.start;
        const end = fiscalRange.endInclusive;
        dateFilter = { $gte: start, $lte: end };
      }
    }

    // 明細クエリ
    const query = {
      group: new mongoose.Types.ObjectId(groupId),
      date: dateFilter,
      cf: cfValue
    };

    if (item) {
      const itemFieldByCf = {
        '支出': 'expense_item',
        '収入': 'income_item',
        '控除': 'dedu_item',
        '貯蓄': 'saving_item'
      };
      const itemField = itemFieldByCf[cfValue];
      if (itemField) {
        query[itemField] = item;
      }
    }

    // 個人スコープの場合はユーザーで絞る
    if (scope === 'user' && req.user?._id) {
      query.user = new mongoose.Types.ObjectId(req.user._id);
    }

    // 追加フィルタ: 支払種別 / 使用者
    if (payment_type && payment_type !== 'Please Choice') {
      query.payment_type = payment_type;
    }
    if (user && mongoose.Types.ObjectId.isValid(user)) {
      query.user = new mongoose.Types.ObjectId(user);
    }

    const finances = await Finance.find(query)
      .populate('user')
      .sort({ date: 1 });

    const count = await Finance.countDocuments(query);
    const currentUser = await FinanceUser.findById(req.user._id).populate('groups');

    // フィルタ用の選択肢
    // 支払種別一覧（重複排除）
    const paymentItems = await PaymentItem.find({ group: groupId });
    const pay_cfs = Array.from(new Set(paymentItems.map(p => p.paymentItem))).sort();

    // グループメンバー
    const group = await Group.findById(groupId).populate('members');
    const whos = group?.members || [];

    return res.render('finance/search_results', {
      finances,
      count,
      page: 'yearly-detail',
      currentUser,
      enableFilterBar: true,
      filters: {
        scope, year: y, month: m, item, cf: cfValue,
        from: from || '', to: to || '',
        payment_type: payment_type || 'Please Choice',
        user: user || ''
      },
      pay_cfs,
      whos
    });
  } catch (err) {
    console.error('❌ 年次明細ドリルダウン エラー:', err);
    return res.status(500).send('年次明細の取得に失敗しました');
  }
});

// 月次明細（支出内訳セルのドリルダウン表示）
router.get('/dashboard/monthly-detail', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const { year, month, item, scope, fy } = req.query;
    const { from, to, payment_type, user, cumulative } = req.query;

    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const y = parseInt(year) || defaultYear;
    const m = month ? parseInt(month) : (new Date().getMonth() + 1);
    const resolvedYearForMonth = y;
    const selectedDate = new Date(y, m - 1, 1);
    const fyValue = Number.isInteger(Number(fy)) ? parseInt(fy) : null;
    const fiscalYear = fyValue || getFiscalYearForDate(selectedDate, fiscalStartMonth) || y;
    const fiscalRange = getFiscalYearRange(fiscalYear, fiscalStartMonth);

    // 日付範囲設定
    let dateFilter = {};
    if (from || to) {
      const start = from ? parseJstDateStart(from) : new Date(y, m - 1, 1);
      const end = to ? parseJstDateEnd(to) : new Date(y, m, 1);
      if (!isNaN(start.getTime())) start.setHours(0, 0, 0, 0);
      if (!isNaN(end.getTime())) end.setHours(23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else if (cumulative) {
      const start = fiscalRange.start;
      const end = new Date(resolvedYearForMonth, m, 0, 23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else {
      const start = new Date(resolvedYearForMonth, m - 1, 1, 0, 0, 0, 0);
      const end = new Date(resolvedYearForMonth, m, 0, 23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    }

    // 明細クエリ（支出の指定項目）
    const query = {
      group: new mongoose.Types.ObjectId(groupId),
      date: dateFilter,
      cf: '支出'
    };

    if (item) {
      query.expense_item = item;
    }

    if (scope === 'user' && req.user?._id) {
      query.user = new mongoose.Types.ObjectId(req.user._id);
    }

    if (payment_type && payment_type !== 'Please Choice') {
      query.payment_type = payment_type;
    }
    if (user && mongoose.Types.ObjectId.isValid(user)) {
      query.user = new mongoose.Types.ObjectId(user);
    }

    const finances = await Finance.find(query)
      .populate('user')
      .sort({ date: 1 });

    const count = await Finance.countDocuments(query);
    const currentUser = await FinanceUser.findById(req.user._id).populate('groups');

    // フィルタ用の選択肢
    const paymentItems = await PaymentItem.find({ group: groupId });
    const pay_cfs = Array.from(new Set(paymentItems.map(p => p.paymentItem))).sort();

    const group = await Group.findById(groupId).populate('members');
    const whos = group?.members || [];

    return res.render('finance/search_results', {
      finances,
      count,
      page: 'monthly-detail',
      currentUser,
      enableFilterBar: true,
      filters: {
        scope, year: y, month: m, item,
        from: from || '', to: to || '',
        payment_type: payment_type || 'Please Choice',
        user: user || ''
      },
      pay_cfs,
      whos
    });
  } catch (err) {
    console.error('❌ 月次明細ドリルダウン エラー:', err);
    return res.status(500).send('月次明細の取得に失敗しました');
  }
});

module.exports = router;
