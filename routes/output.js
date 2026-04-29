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
const FinanceExBudgetPersonal = require('../models/finance_ex_budget_personal');
const FinanceMonthlyCalendar = require('../models/finance_monthly_calendar');
const FinancePaymentTypeCheck = require('../models/finance_payment_type_check');
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
const JST_DATE_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

const normalizeCategoryName = (value) => String(value || '').replace(/\s+/g, '').replace(/　/g, '').trim();

const normalizePaymentTypeName = (value) => String(value || '').replace(/\s+/g, '').replace(/　/g, '').trim();

const pad2 = (num) => String(num).padStart(2, '0');

const toDateKey = (year, month, day) => `${year}-${pad2(month)}-${pad2(day)}`;

const dateToKey = (date) => toDateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());

const getNthWeekdayOfMonth = (year, month, weekday, nth) => {
  const firstDay = new Date(year, month - 1, 1).getDay();
  const day = 1 + ((7 + weekday - firstDay) % 7) + (nth - 1) * 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day <= daysInMonth ? day : null;
};

const getVernalEquinoxDay = (year) => {
  if (year < 1980 || year > 2099) return 20;
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
};

const getAutumnalEquinoxDay = (year) => {
  if (year < 1980 || year > 2099) return 23;
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
};

const setHoliday = (holidayMap, year, month, day, name) => {
  const daysInMonth = new Date(year, month, 0).getDate();
  if (!day || day < 1 || day > daysInMonth) return;
  holidayMap.set(toDateKey(year, month, day), name);
};

const buildJapaneseHolidayMap = (year) => {
  const holidayMap = new Map();

  setHoliday(holidayMap, year, 1, 1, '元日');

  if (year >= 2000) {
    setHoliday(holidayMap, year, 1, getNthWeekdayOfMonth(year, 1, 1, 2), '成人の日');
  } else {
    setHoliday(holidayMap, year, 1, 15, '成人の日');
  }

  if (year >= 1967) {
    setHoliday(holidayMap, year, 2, 11, '建国記念の日');
  }

  if (year >= 2020) {
    setHoliday(holidayMap, year, 2, 23, '天皇誕生日');
  } else if (year >= 1989 && year <= 2018) {
    setHoliday(holidayMap, year, 12, 23, '天皇誕生日');
  } else if (year >= 1949 && year <= 1988) {
    setHoliday(holidayMap, year, 4, 29, '天皇誕生日');
  }

  setHoliday(holidayMap, year, 3, getVernalEquinoxDay(year), '春分の日');

  if (year >= 2007) {
    setHoliday(holidayMap, year, 4, 29, '昭和の日');
  } else if (year >= 1989) {
    setHoliday(holidayMap, year, 4, 29, 'みどりの日');
  }

  setHoliday(holidayMap, year, 5, 3, '憲法記念日');
  if (year >= 2007) {
    setHoliday(holidayMap, year, 5, 4, 'みどりの日');
  }
  setHoliday(holidayMap, year, 5, 5, 'こどもの日');

  if (year === 2020) {
    setHoliday(holidayMap, year, 7, 23, '海の日');
  } else if (year === 2021) {
    setHoliday(holidayMap, year, 7, 22, '海の日');
  } else if (year >= 2003) {
    setHoliday(holidayMap, year, 7, getNthWeekdayOfMonth(year, 7, 1, 3), '海の日');
  } else if (year >= 1996) {
    setHoliday(holidayMap, year, 7, 20, '海の日');
  }

  if (year === 2020) {
    setHoliday(holidayMap, year, 8, 10, '山の日');
  } else if (year === 2021) {
    setHoliday(holidayMap, year, 8, 8, '山の日');
  } else if (year >= 2016) {
    setHoliday(holidayMap, year, 8, 11, '山の日');
  }

  if (year >= 2003) {
    setHoliday(holidayMap, year, 9, getNthWeekdayOfMonth(year, 9, 1, 3), '敬老の日');
  } else if (year >= 1966) {
    setHoliday(holidayMap, year, 9, 15, '敬老の日');
  }

  setHoliday(holidayMap, year, 9, getAutumnalEquinoxDay(year), '秋分の日');

  if (year === 2020) {
    setHoliday(holidayMap, year, 7, 24, 'スポーツの日');
  } else if (year === 2021) {
    setHoliday(holidayMap, year, 7, 23, 'スポーツの日');
  } else if (year >= 2022) {
    setHoliday(holidayMap, year, 10, getNthWeekdayOfMonth(year, 10, 1, 2), 'スポーツの日');
  } else if (year >= 2000) {
    setHoliday(holidayMap, year, 10, getNthWeekdayOfMonth(year, 10, 1, 2), '体育の日');
  } else if (year >= 1966) {
    setHoliday(holidayMap, year, 10, 10, '体育の日');
  }

  setHoliday(holidayMap, year, 11, 3, '文化の日');
  setHoliday(holidayMap, year, 11, 23, '勤労感謝の日');

  if (year === 1990) {
    setHoliday(holidayMap, year, 11, 12, '即位礼正殿の儀');
  }
  if (year === 2019) {
    setHoliday(holidayMap, year, 5, 1, '天皇の即位の日');
    setHoliday(holidayMap, year, 10, 22, '即位礼正殿の儀');
  }

  if (year >= 1986) {
    for (let dt = new Date(year, 0, 2); dt <= new Date(year, 11, 30); dt.setDate(dt.getDate() + 1)) {
      const key = dateToKey(dt);
      if (holidayMap.has(key)) continue;
      const prev = new Date(dt);
      prev.setDate(prev.getDate() - 1);
      const next = new Date(dt);
      next.setDate(next.getDate() + 1);
      if (prev.getFullYear() !== year || next.getFullYear() !== year) continue;
      if (holidayMap.has(dateToKey(prev)) && holidayMap.has(dateToKey(next))) {
        holidayMap.set(key, '国民の休日');
      }
    }
  }

  if (year >= 1973) {
    const keys = Array.from(holidayMap.keys()).sort();
    for (const key of keys) {
      const [y, m, d] = key.split('-').map(Number);
      const holidayDate = new Date(y, m - 1, d);
      if (holidayDate.getDay() !== 0) continue;
      const substitute = new Date(holidayDate);
      do {
        substitute.setDate(substitute.getDate() + 1);
      } while (holidayMap.has(dateToKey(substitute)));
      if (substitute.getFullYear() === year) {
        holidayMap.set(dateToKey(substitute), '振替休日');
      }
    }
  }

  return holidayMap;
};

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

const joinTexts = (values) => {
  const ordered = [];
  for (const raw of values || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    ordered.push(text);
  }
  return ordered.join(', ');
};

const joinUniqueTexts = (values) => {
  const seen = new Set();
  const ordered = [];
  for (const raw of values || []) {
    const text = String(raw || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    ordered.push(text);
  }
  return ordered.join(', ');
};

const createCalendarDayRow = (year, month, day) => ({
  day,
  weekday: WEEKDAY_JA[new Date(year, month - 1, day).getDay()],
  memos: [],
  plannedNote: '',
  memoText: '',
  holidayName: '',
  dayToneClass: '',
  cashTopupAmount: 0,
  cashAmount: 0,
  nonCashAmount: 0,
  cashUsedAmount: 0,
  cashBalance: 0,
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
  bucket.contentText = joinUniqueTexts(bucket.contents);
  return bucket;
};

const summarizeCalendarRows = (rows) => {
  const summary = rows.reduce((acc, row) => {
    acc.incomeAmount += row.income.amount;
    acc.deductionAmount += row.deduction.amount;
    acc.foodSeasoningAmount += row.foodSeasoning.amount;
    acc.otherExpenseAmount += row.otherExpense.amount;
    acc.cashAmount += row.cashAmount;
    acc.nonCashAmount += row.nonCashAmount;
    acc.cashUsedAmount += row.cashUsedAmount;
    return acc;
  }, {
    incomeAmount: 0,
    deductionAmount: 0,
    foodSeasoningAmount: 0,
    otherExpenseAmount: 0,
    cashAmount: 0,
    nonCashAmount: 0,
    cashUsedAmount: 0,
    cashBalance: 0,
    balance: 0
  });

  summary.balance =
    summary.incomeAmount
    - summary.deductionAmount
    - summary.foodSeasoningAmount
    - summary.otherExpenseAmount;

  return summary;
};

const parseYearMonth = (ymRaw, fallbackDate = new Date()) => {
  let year = fallbackDate.getFullYear();
  let month = fallbackDate.getMonth() + 1;
  if (typeof ymRaw === 'string') {
    const matched = ymRaw.match(/^(\d{4})-(\d{1,2})$/);
    if (matched) {
      const parsedYear = Number(matched[1]);
      const parsedMonth = Number(matched[2]);
      if (Number.isInteger(parsedYear) && parsedMonth >= 1 && parsedMonth <= 12) {
        year = parsedYear;
        month = parsedMonth;
      }
    }
  }
  return { year, month };
};

const formatJstDate = (value) => {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '';
  return JST_DATE_FORMATTER.format(dt).replace(/\//g, '-');
};

const getFinanceCategoryLabel = (finance) => {
  const cf = String(finance?.cf || '').trim();
  if (cf === '支出') return String(finance?.expense_item || '').trim();
  if (cf === '収入') return String(finance?.income_item || '').trim();
  if (cf === '控除') return String(finance?.dedu_item || '').trim();
  if (cf === '貯蓄') return String(finance?.saving_item || '').trim();
  return '';
};

const normalizeCalendarDay = (value) => {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return day;
};

const getJstTodayParts = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date());

  const getPart = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day')
  };
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

function getMonthlyCumulativeMeta(calendarYear, calendarMonth, fiscalStartMonth = 1) {
    const selectedDate = new Date(calendarYear, calendarMonth - 1, 1, 0, 0, 0, 0);
    const fiscalYear = getFiscalYearForDate(selectedDate, fiscalStartMonth) ?? calendarYear;
    const fiscalRange = getFiscalYearRange(fiscalYear, fiscalStartMonth);
    const endOfSelectedMonth = new Date(calendarYear, calendarMonth, 0, 23, 59, 59, 999);
    const budgetMonthCount = (getFiscalMonthIndex(calendarMonth, fiscalStartMonth) ?? 0) + 1;
    const label = `${fiscalRange.start.getFullYear()}年${fiscalRange.start.getMonth() + 1}月〜${endOfSelectedMonth.getFullYear()}年${endOfSelectedMonth.getMonth() + 1}月`;

    return {
        fiscalYear,
        start: fiscalRange.start,
        end: endOfSelectedMonth,
        budgetMonthCount,
        label
    };
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
  const cumulativeMeta = getMonthlyCumulativeMeta(year, month, fiscalStartMonth);
  const fiscalYear = cumulativeMeta.fiscalYear;

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

  const budgets = await FinanceExBudgetPersonal.find({
    group: groupId,
    user: userId,
    year: String(fiscalYear)
  });
  const budgetMap = {};
  for (let b of budgets) {
    budgetMap[b.expense_item] = Number(b.budget) || 0;
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

  // === 累計集計: 年度開始月から表示中の月まで ===
  const startOfYear = cumulativeMeta.start;
  const endOfCurrentMonth = cumulativeMeta.end;

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
    const budget = monthlyBudget * cumulativeMeta.budgetMonthCount;
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
    cumulativeRangeLabel: cumulativeMeta.label,
    fiscalYear
  });
});

// 月次カレンダー集計（個人） 繰越現金保存
router.post('/dashboard/monthly-calendar-m/carry-cash', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const { year, month } = parseYearMonth(req.body.ym, new Date());
    const ymValue = `${year}-${String(month).padStart(2, '0')}`;
    const activeGroup = await Group.findById(groupId).select('financeWalletManagementEnabled').lean();
    const walletManagementEnabled = activeGroup?.financeWalletManagementEnabled === true;
    if (!walletManagementEnabled) {
      req.flash('error', 'お財布管理が「しない」のため、繰越現金は保存できません');
      return res.redirect(`/export/dashboard/monthly-calendar-m?ym=${ymValue}`);
    }

    const rawCarryCash = Number(req.body.carryCash);
    const carryCash = Number.isFinite(rawCarryCash) ? rawCarryCash : 0;

    await FinanceMonthlyCalendar.findOneAndUpdate(
      { group: groupId, year, month },
      {
        $set: {
          ym: ymValue,
          carryCash,
          updatedBy: req.user._id
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    req.flash('success', '繰越現金を保存しました');
    return res.redirect(`/export/dashboard/monthly-calendar-m?ym=${ymValue}`);
  } catch (err) {
    console.error('❌ 繰越現金保存エラー:', err);
    req.flash('error', '繰越現金の保存に失敗しました');
    return res.redirect('/export/dashboard/monthly-calendar-m');
  }
});

// 月次カレンダー 予定メモ登録・更新
router.post('/dashboard/monthly-calendar-m/memo', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      return res.status(400).json({ ok: false, message: 'アクティブなグループが選択されていません' });
    }

    const { year, month } = parseYearMonth(req.body.ym, new Date());
    const day = normalizeCalendarDay(req.body.day);
    if (!day) {
      return res.status(400).json({ ok: false, message: '日付が不正です' });
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) {
      return res.status(400).json({ ok: false, message: 'この月に存在しない日付です' });
    }

    const ymValue = `${year}-${String(month).padStart(2, '0')}`;
    const note = String(req.body.note || '').trim();
    const rawCashTopup = Number(req.body.cashTopup);
    const activeGroup = await Group.findById(groupId).select('financeWalletManagementEnabled').lean();
    const walletManagementEnabled = activeGroup?.financeWalletManagementEnabled === true;
    const cashTopup = walletManagementEnabled && Number.isFinite(rawCashTopup)
      ? Math.max(rawCashTopup, 0)
      : 0;

    const doc = await FinanceMonthlyCalendar.findOneAndUpdate(
      { group: groupId, year, month },
      {
        $setOnInsert: { ym: ymValue, plannedMemos: [] }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const plannedMemos = Array.isArray(doc.plannedMemos)
      ? doc.plannedMemos.map((m) => ({
          day: Number(m.day),
          note: String(m.note || '').trim(),
          cashTopup: Number(m.cashTopup) || 0
        }))
      : [];

    const nextEntry = { day, note, cashTopup };
    const targetIndex = plannedMemos.findIndex((m) => m.day === day);
    if (!note && cashTopup === 0) {
      if (targetIndex >= 0) {
        plannedMemos.splice(targetIndex, 1);
      }
    } else {
      if (targetIndex >= 0) {
        plannedMemos[targetIndex] = nextEntry;
      } else {
        plannedMemos.push(nextEntry);
      }
    }

    plannedMemos.sort((a, b) => a.day - b.day);
    doc.ym = ymValue;
    doc.plannedMemos = plannedMemos;
    doc.updatedBy = req.user._id;
    await doc.save();

    return res.json({ ok: true, entry: nextEntry });
  } catch (err) {
    console.error('❌ カレンダーメモ保存エラー:', err);
    return res.status(500).json({ ok: false, message: '保存に失敗しました' });
  }
});

// 月次カレンダー 予定メモ削除
router.post('/dashboard/monthly-calendar-m/memo/delete', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      return res.status(400).json({ ok: false, message: 'アクティブなグループが選択されていません' });
    }

    const { year, month } = parseYearMonth(req.body.ym, new Date());
    const day = normalizeCalendarDay(req.body.day);
    if (!day) {
      return res.status(400).json({ ok: false, message: '日付が不正です' });
    }
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) {
      return res.status(400).json({ ok: false, message: 'この月に存在しない日付です' });
    }

    const doc = await FinanceMonthlyCalendar.findOne({ group: groupId, year, month });
    if (!doc) {
      return res.json({ ok: true });
    }

    const before = Array.isArray(doc.plannedMemos) ? doc.plannedMemos.length : 0;
    doc.plannedMemos = (doc.plannedMemos || []).filter((m) => Number(m.day) !== day);
    const after = doc.plannedMemos.length;
    if (before !== after) {
      doc.updatedBy = req.user._id;
      await doc.save();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ カレンダーメモ削除エラー:', err);
    return res.status(500).json({ ok: false, message: '削除に失敗しました' });
  }
});

// 月次カレンダー集計（個人）
router.get('/dashboard/monthly-calendar-m', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const { year, month } = parseYearMonth(req.query.ym, new Date());

    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 1, 0, 0, 0, 0);
    const daysInMonth = new Date(year, month, 0).getDate();
    const activeGroup = await Group.findById(groupId).select('group_name financeWalletManagementEnabled').lean();
    const groupName = activeGroup?.group_name || 'グループ';
    const walletManagementEnabled = activeGroup?.financeWalletManagementEnabled === true;

    const finances = await Finance.find({
      group: groupId,
      date: { $gte: start, $lt: end }
    })
      .select('date day cf content memo amount payment_type income_item dedu_item expense_item')
      .lean();

    const dayRows = Array.from(
      { length: daysInMonth },
      (_, idx) => createCalendarDayRow(year, month, idx + 1)
    );
    const holidayMap = buildJapaneseHolidayMap(year);
    const calendarSetting = await FinanceMonthlyCalendar.findOne({ group: groupId, year, month }).lean();
    const carryCash = walletManagementEnabled ? (Number(calendarSetting?.carryCash) || 0) : 0;
    const plannedMemoMap = new Map();
    (calendarSetting?.plannedMemos || []).forEach((planned) => {
      const day = normalizeCalendarDay(planned?.day);
      if (!day || day > daysInMonth) return;
      plannedMemoMap.set(day, {
        note: String(planned?.note || '').trim(),
        cashTopup: walletManagementEnabled ? (Number(planned?.cashTopup) || 0) : 0
      });
    });

    for (const entry of finances) {
      const dayFromDate = getJstDay(entry.date);
      const day = Number.isInteger(dayFromDate) ? dayFromDate : Number(entry.day);
      if (!Number.isInteger(day) || day < 1 || day > daysInMonth) continue;
      const row = dayRows[day - 1];
      const memoText = String(entry.memo || '').trim();
      if (memoText) {
        row.memos.push(memoText);
      }
      const entryAmount = Number(entry.amount) || 0;
      const paymentType = normalizePaymentTypeName(entry.payment_type);
      if (entry.cf === '支出') {
        if (paymentType === '現金') {
          row.cashAmount += entryAmount;
          row.cashUsedAmount += entryAmount;
        } else {
          row.nonCashAmount += entryAmount;
        }
      }

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
      const planned = plannedMemoMap.get(row.day) || { note: '', cashTopup: 0 };
      row.plannedNote = planned.note;
      row.cashTopupAmount = planned.cashTopup;
      row.holidayName = holidayMap.get(toDateKey(year, month, row.day)) || '';
      if (row.holidayName || row.weekday === '日') {
        row.dayToneClass = 'is-sunday-holiday';
      } else if (row.weekday === '土') {
        row.dayToneClass = 'is-saturday';
      } else {
        row.dayToneClass = '';
      }

      const transactionMemoText = joinTexts(row.memos);
      const memoParts = [];
      if (row.holidayName) memoParts.push(row.holidayName);
      if (row.plannedNote) memoParts.push(row.plannedNote);
      if (walletManagementEnabled && row.cashTopupAmount) memoParts.push(`現金追加 +${row.cashTopupAmount.toLocaleString()}`);
      if (transactionMemoText) memoParts.push(transactionMemoText);
      row.memoText = memoParts.join(', ');

      finalizeCalendarBucket(row.income);
      finalizeCalendarBucket(row.deduction);
      finalizeCalendarBucket(row.foodSeasoning);
      finalizeCalendarBucket(row.otherExpense);
    });

    let runningCash = carryCash;
    dayRows.forEach((row) => {
      runningCash += row.cashTopupAmount;
      runningCash -= row.cashUsedAmount;
      row.cashBalance = runningCash;
    });

    const subtotalRows = dayRows.filter((row) => row.day <= 15);
    const subtotal = summarizeCalendarRows(subtotalRows);
    const total = summarizeCalendarRows(dayRows);
    subtotal.cashBalance = subtotalRows.length > 0
      ? subtotalRows[subtotalRows.length - 1].cashBalance
      : carryCash;
    total.cashBalance = dayRows.length > 0
      ? dayRows[dayRows.length - 1].cashBalance
      : carryCash;
    const todayJst = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).format(new Date());

    const todayJstParts = getJstTodayParts();
    const todayDay = (year === todayJstParts.year && month === todayJstParts.month)
      ? todayJstParts.day
      : null;

    res.render('dashboard/monthlyCalendar', {
      year,
      month,
      ymValue: `${year}-${String(month).padStart(2, '0')}`,
      titlePrefix: `${groupName}`,
      formAction: '/export/dashboard/monthly-calendar-m',
      carryCashAction: '/export/dashboard/monthly-calendar-m/carry-cash',
      memoSaveAction: '/export/dashboard/monthly-calendar-m/memo',
      memoDeleteAction: '/export/dashboard/monthly-calendar-m/memo/delete',
      carryCash,
      dayRows,
      subtotal,
      total,
      walletManagementEnabled,
      todayDay,
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
  const cumulativeMeta = getMonthlyCumulativeMeta(year, month, fiscalStartMonth);
  const fiscalYear = cumulativeMeta.fiscalYear;

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

  // === 累計集計: 年度開始月から表示中の月まで ===
  const startOfYear = cumulativeMeta.start;
  const endOfCurrentMonth = cumulativeMeta.end;

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
    const budget = monthlyBudget * cumulativeMeta.budgetMonthCount;
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
    cumulativeRangeLabel: cumulativeMeta.label,
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
          expense_item: 1,
          sub_tag: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item',
            sub_tag: '$sub_tag'
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
    const monthlyExpenseTagDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
      monthlyExpenseTagDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item, sub_tag } = r._id;
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
        const tag = (sub_tag || '').trim();
        if (tag) {
          if (!monthlyExpenseTagDetail[fiscalMonth][expense_item]) {
            monthlyExpenseTagDetail[fiscalMonth][expense_item] = {};
          }
          monthlyExpenseTagDetail[fiscalMonth][expense_item][tag] =
            (monthlyExpenseTagDetail[fiscalMonth][expense_item][tag] || 0) + total;
        }
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
      monthlyExpenseTagDetail,
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
          expense_item: 1,
          sub_tag: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            cf: '$cf',
            expense_item: '$expense_item',
            sub_tag: '$sub_tag'
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
    const monthlyExpenseTagDetail = {};

    for (let m = 1; m <= 12; m++) {
      monthlySummary[m] = { 支出: 0, 控除: 0, 収入: 0, 貯蓄: 0 };
      monthlyExpensesDetail[m] = {};
      monthlyExpenseTagDetail[m] = {};
    }

    result.forEach(r => {
      const { month, cf, expense_item, sub_tag } = r._id;
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
        const tag = (sub_tag || '').trim();
        if (tag) {
          if (!monthlyExpenseTagDetail[fiscalMonth][expense_item]) {
            monthlyExpenseTagDetail[fiscalMonth][expense_item] = {};
          }
          monthlyExpenseTagDetail[fiscalMonth][expense_item][tag] =
            (monthlyExpenseTagDetail[fiscalMonth][expense_item][tag] || 0) + total;
        }
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
      monthlyExpenseTagDetail,
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

// 月次支払種別チェック（表示）
router.get('/payment-check', isLoggedIn, async (req, res) => {
  try {
    const { year, month } = parseYearMonth(req.query.ym, new Date());
    const ymValue = `${year}-${String(month).padStart(2, '0')}`;
    const selectedPaymentType = String(req.query.payment_type || '').trim();
    const userObjectId = new mongoose.Types.ObjectId(req.user._id);
    const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month, 1, 0, 0, 0, 0);

    const [currentUser, paymentItems] = await Promise.all([
      FinanceUser.findById(req.user._id).populate('groups'),
      PaymentItem.find({
        user: userObjectId,
        isLive: true
      })
        .sort({ display_order: 1 })
        .lean()
    ]);

    const paymentTypeOptions = [];
    const seen = new Set();
    for (const item of paymentItems) {
      const name = String(item.paymentItem || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      paymentTypeOptions.push(name);
    }
    if (selectedPaymentType && !seen.has(selectedPaymentType)) {
      paymentTypeOptions.push(selectedPaymentType);
    }

    let uncheckedEntries = [];
    let checkedEntries = [];

    if (selectedPaymentType) {
      const currentPath = (typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/'))
        ? req.originalUrl
        : `/export/payment-check?${new URLSearchParams({ ym: ymValue, payment_type: selectedPaymentType }).toString()}`;
      const [finances, checkStatus] = await Promise.all([
        Finance.find({
          user: userObjectId,
          payment_type: selectedPaymentType,
          date: { $gte: monthStart, $lt: monthEnd }
        })
          .select('date cf income_item expense_item dedu_item saving_item content amount')
          .sort({ date: 1, entry_date: 1, _id: 1 })
          .lean(),
        FinancePaymentTypeCheck.findOne({
          user: userObjectId,
          group: null,
          ym: ymValue,
          paymentType: selectedPaymentType
        }).lean()
      ]);

      const checkedIdSet = new Set(
        (checkStatus?.checkedFinanceIds || []).map((id) => id.toString())
      );

      finances.forEach((finance) => {
        const row = {
          id: finance._id.toString(),
          date: formatJstDate(finance.date),
          cf: String(finance.cf || ''),
          category: getFinanceCategoryLabel(finance),
          content: String(finance.content || ''),
          amount: Number(finance.amount) || 0,
          editUrl: `/finance/${finance._id.toString()}/edit?returnTo=${encodeURIComponent(currentPath)}`
        };

        if (checkedIdSet.has(row.id)) {
          checkedEntries.push(row);
        } else {
          uncheckedEntries.push(row);
        }
      });
    }

    return res.render('finance/paymentTypeCheck', {
      page: 'payment-check',
      currentUser,
      ymValue,
      selectedPaymentType,
      paymentTypeOptions,
      uncheckedEntries,
      checkedEntries,
      formAction: '/export/payment-check',
      toggleAction: '/export/payment-check/toggle'
    });
  } catch (err) {
    console.error('❌ 月次支払種別チェック画面エラー:', err);
    return res.status(500).send('月次支払種別チェックの表示に失敗しました');
  }
});

// 月次支払種別チェック（チェック状態更新）
router.post('/payment-check/toggle', isLoggedIn, async (req, res) => {
  try {
    const { year, month } = parseYearMonth(req.body.ym, new Date());
    const ymValue = `${year}-${String(month).padStart(2, '0')}`;
    const paymentType = String(req.body.paymentType || '').trim();
    const financeId = String(req.body.financeId || '').trim();
    const checked = req.body.checked === true
      || req.body.checked === 'true'
      || req.body.checked === 1
      || req.body.checked === '1'
      || req.body.checked === 'on';

    if (!paymentType) {
      return res.status(400).json({ ok: false, message: '支払種別が未指定です' });
    }
    if (!mongoose.Types.ObjectId.isValid(financeId)) {
      return res.status(400).json({ ok: false, message: '対象データが不正です' });
    }

    const userObjectId = new mongoose.Types.ObjectId(req.user._id);
    const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month, 1, 0, 0, 0, 0);

    const target = await Finance.findOne({
      _id: new mongoose.Types.ObjectId(financeId),
      user: userObjectId,
      payment_type: paymentType,
      date: { $gte: monthStart, $lt: monthEnd }
    }).select('_id').lean();

    if (!target) {
      return res.status(404).json({ ok: false, message: '対象データが見つかりません' });
    }

    const filter = {
      user: userObjectId,
      group: null,
      ym: ymValue,
      paymentType
    };

    if (checked) {
      await FinancePaymentTypeCheck.findOneAndUpdate(
        filter,
        { $addToSet: { checkedFinanceIds: target._id } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      const updated = await FinancePaymentTypeCheck.findOneAndUpdate(
        filter,
        { $pull: { checkedFinanceIds: target._id } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (updated && Array.isArray(updated.checkedFinanceIds) && updated.checkedFinanceIds.length === 0) {
        await FinancePaymentTypeCheck.deleteOne({ _id: updated._id });
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ 月次支払種別チェック更新エラー:', err);
    return res.status(500).json({ ok: false, message: '更新に失敗しました' });
  }
});

// 年次支払種別集計
router.get('/payment-summary-yearly', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const userObjectId = new mongoose.Types.ObjectId(req.user._id);
    const groupObjectId = new mongoose.Types.ObjectId(groupId);
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const defaultYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const requestedYear = Number.parseInt(req.query.year, 10);
    const fiscalMonths = getFiscalMonths(fiscalStartMonth);
    const monthIndexMap = new Map(fiscalMonths.map((month, index) => [month, index]));

    const [currentUser, paymentItems, availableYearDocs] = await Promise.all([
      FinanceUser.findById(req.user._id).populate('groups'),
      PaymentItem.find({
        user: userObjectId,
        group: groupObjectId,
        isLive: true
      })
        .sort({ display_order: 1 })
        .lean(),
      Finance.aggregate([
        {
          $match: {
            user: userObjectId,
            group: groupObjectId,
            cf: '支出'
          }
        },
        {
          $project: {
            calendarYear: { $year: { date: '$date', timezone: 'Asia/Tokyo' } },
            calendarMonth: { $month: { date: '$date', timezone: 'Asia/Tokyo' } }
          }
        },
        {
          $project: {
            fiscalYear: {
              $cond: [
                { $gte: ['$calendarMonth', fiscalStartMonth] },
                '$calendarYear',
                { $subtract: ['$calendarYear', 1] }
              ]
            }
          }
        },
        {
          $group: {
            _id: '$fiscalYear'
          }
        },
        {
          $sort: {
            _id: -1
          }
        }
      ])
    ]);

    const availableYears = availableYearDocs
      .map((doc) => Number(doc?._id))
      .filter((value) => Number.isInteger(value));
    const year = availableYears.includes(requestedYear)
      ? requestedYear
      : (availableYears[0] ?? defaultYear);
    const fiscalRange = getFiscalYearRange(year, fiscalStartMonth);

    const summaryResult = await Finance.aggregate([
      {
        $match: {
          user: userObjectId,
          group: groupObjectId,
          cf: '支出',
          date: {
            $gte: fiscalRange.start,
            $lt: fiscalRange.end
          }
        }
      },
      {
        $project: {
          month: { $month: { date: '$date', timezone: 'Asia/Tokyo' } },
          payment_type: 1,
          amount: 1
        }
      },
      {
        $group: {
          _id: {
            month: '$month',
            payment_type: '$payment_type'
          },
          total: { $sum: '$amount' }
        }
      },
      {
        $sort: {
          '_id.month': 1,
          '_id.payment_type': 1
        }
      }
    ]);

    const paymentTypeOrder = [];
    const paymentTypeMetaMap = new Map();
    const ensurePaymentType = (rawValue) => {
      const key = String(rawValue || '').trim();
      if (paymentTypeMetaMap.has(key)) return paymentTypeMetaMap.get(key);
      const meta = {
        key,
        label: key || '未設定'
      };
      paymentTypeMetaMap.set(key, meta);
      paymentTypeOrder.push(key);
      return meta;
    };

    paymentItems.forEach((item) => {
      ensurePaymentType(item.paymentItem);
    });
    summaryResult.forEach((row) => {
      ensurePaymentType(row?._id?.payment_type);
    });

    const monthlyGrandTotals = Array.from({ length: 12 }, () => 0);
    const summaryRowMap = new Map(
      paymentTypeOrder.map((key) => [
        key,
        {
          paymentTypeKey: key,
          paymentTypeLabel: paymentTypeMetaMap.get(key)?.label || key || '未設定',
          monthlyTotals: Array.from({ length: 12 }, () => 0),
          yearTotal: 0
        }
      ])
    );

    summaryResult.forEach((row) => {
      const paymentTypeKey = String(row?._id?.payment_type || '').trim();
      const month = Number(row?._id?.month);
      const monthIndex = monthIndexMap.get(month);
      if (monthIndex === undefined) return;

      if (!summaryRowMap.has(paymentTypeKey)) {
        const meta = ensurePaymentType(paymentTypeKey);
        summaryRowMap.set(paymentTypeKey, {
          paymentTypeKey,
          paymentTypeLabel: meta.label,
          monthlyTotals: Array.from({ length: 12 }, () => 0),
          yearTotal: 0
        });
      }

      const total = Number(row.total) || 0;
      const targetRow = summaryRowMap.get(paymentTypeKey);
      targetRow.monthlyTotals[monthIndex] += total;
      targetRow.yearTotal += total;
      monthlyGrandTotals[monthIndex] += total;
    });

    const buildDetailUrl = ({ month, paymentTypeKey }) => {
      const params = new URLSearchParams({
        scope: 'user',
        year: String(year),
        cf: '支出'
      });
      if (month) params.set('month', String(month));
      if (paymentTypeKey) params.set('payment_type', paymentTypeKey);
      return `/export/dashboard/yearly-detail?${params.toString()}`;
    };

    const summaryRows = paymentTypeOrder.map((key) => {
      const baseRow = summaryRowMap.get(key);
      const monthCells = fiscalMonths.map((month, index) => ({
        month,
        amount: baseRow?.monthlyTotals?.[index] || 0,
        detailUrl: key ? buildDetailUrl({ month, paymentTypeKey: key }) : null
      }));
      return {
        paymentTypeKey: key,
        paymentTypeLabel: baseRow?.paymentTypeLabel || key || '未設定',
        monthCells,
        yearTotal: baseRow?.yearTotal || 0,
        totalDetailUrl: key ? buildDetailUrl({ paymentTypeKey: key }) : null
      };
    });

    const monthlyTotalCells = fiscalMonths.map((month, index) => ({
      month,
      amount: monthlyGrandTotals[index] || 0,
      detailUrl: buildDetailUrl({ month })
    }));
    const grandTotal = monthlyGrandTotals.reduce((sum, value) => sum + value, 0);

    if (availableYears.length === 0) {
      availableYears.push(year);
    }

    const fiscalPeriodLabel = `${fiscalRange.start.getFullYear()}年${fiscalRange.start.getMonth() + 1}月〜${fiscalRange.endInclusive.getFullYear()}年${fiscalRange.endInclusive.getMonth() + 1}月`;

    return res.render('finance/paymentTypeYearlySummary', {
      page: 'payment-summary-yearly',
      currentUser,
      year,
      availableYears,
      fiscalStartMonth,
      fiscalMonths,
      fiscalPeriodLabel,
      summaryRows,
      monthlyTotalCells,
      grandTotal,
      grandTotalDetailUrl: buildDetailUrl({}),
      formAction: '/export/payment-summary-yearly'
    });
  } catch (err) {
    console.error('❌ 年次支払種別集計画面エラー:', err);
    return res.status(500).send('年次支払種別集計の表示に失敗しました');
  }
});


// 年次明細（支出内訳セルのドリルダウン表示）
router.get('/dashboard/yearly-detail', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }

    const { year, month, item, scope, cf } = req.query;
    const { from, to, payment_type, user, sub_tag } = req.query;

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
    if (sub_tag && sub_tag !== 'Please Choice') {
      query.sub_tag = sub_tag;
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
    const sub_tag_options = (await Finance.distinct('sub_tag', { group: new mongoose.Types.ObjectId(groupId) }))
      .filter(v => v && v !== 'Please Choice')
      .sort();

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
        sub_tag: sub_tag || '',
        user: user || ''
      },
      pay_cfs,
      whos,
      sub_tag_options
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
    const { from, to, payment_type, user, cumulative, sub_tag } = req.query;

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
    if (sub_tag && sub_tag !== 'Please Choice') {
      query.sub_tag = sub_tag;
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
    const sub_tag_options = (await Finance.distinct('sub_tag', { group: new mongoose.Types.ObjectId(groupId) }))
      .filter(v => v && v !== 'Please Choice')
      .sort();

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
        sub_tag: sub_tag || '',
        user: user || ''
      },
      pay_cfs,
      whos,
      sub_tag_options
    });
  } catch (err) {
    console.error('❌ 月次明細ドリルダウン エラー:', err);
    return res.status(500).send('月次明細の取得に失敗しました');
  }
});

module.exports = router;
