const express = require('express');
const router = express.Router();
const catchAsync = require('../Utils/catchAsync');
const Finance = require('../models/finance');
const mongoose = require('mongoose');
const path = require('path');
const methodOverride = require('method-override');
const FinanceUser = require('../models/users');
const FinanceExBudget = require('../models/finance_ex_budget');
const Group = require('../models/groups');
const dashboardController = require('../controllers/dashboardController');
const Items = require('../models/finance_items');
const PaymentItem = require('../models/paymentItems');

const xlsx = require('xlsx');
const { isLoggedIn, logAction } = require('../middleware');

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

    // データをExcelに変換
    const data = finances.map(item => ({
        日付: item.date,
        月: item.month,
        日: item.day,
        区分: item.cf,
        収入項目: item.income_item,
        支出項目: item.expense_item,
        控除項目: item.dedu_item,
        貯蓄項目: item.saving_item,
        内容: item.content,
        金額: item.amount,
        支払種別: item.payment_type,
        使用者: item.user?.displayname || '',
        no: item._id.toString()
    }));

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Finance Data');

    // ファイル名と保存場所の指定
    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const formattedTime = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    // const homedir = require('os').homedir();
    // const outputPath = path.join(homedir, 'Downloads', `exported_data_${formattedDate}_${formattedTime}.xlsx`);
    const outputDir = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(require('os').homedir(), 'Downloads');
    const outputPath = path.join(outputDir, `exported_data_${formattedDate}_${formattedTime}.xlsx`);

    // Excelファイルとして保存
    xlsx.writeFile(wb, outputPath);

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

  const budgets = await FinanceExBudget.find({ group: groupId, year });
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

  // === 累計集計: 1月から選択月まで ===
  const startOfYear = new Date(year, 0, 1); // January 1st
  const endOfCurrentMonth = new Date(year, month, 0, 23, 59, 59, 999); // End of current month

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
    const budget = monthlyBudget * month;
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
    viewType: 'user'
  });
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
  const budgets = await FinanceExBudget.find({ group: groupId, year });
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

  // === 累計集計: 1月から選択月まで ===
  const startOfYear = new Date(year, 0, 1); // January 1st
  const endOfCurrentMonth = new Date(year, month, 0, 23, 59, 59, 999); // End of current month

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
    const budget = monthlyBudget * month;
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
    viewType: 'group'
  });
});

//年間収支実績（個人）
router.get('/dashboard/yearly-m', async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          user: new mongoose.Types.ObjectId(userId),
          date: {
            $gte: new Date(`${year}-01-01`),
            $lte: new Date(`${year}-12-31`)
          }
        }
      },
      {
        $project: {
          month: { $month: '$date' },
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
      const total = r.total;
      if (!monthlySummary[month][cf]) monthlySummary[month][cf] = 0;
      monthlySummary[month][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[month][expense_item]) {
          monthlyExpensesDetail[month][expense_item] = 0;
        }
        monthlyExpensesDetail[month][expense_item] += total;
      }
    });
    // Dynamically build ex_cfs from budget items
    const budgets = await FinanceExBudget.find({ group: groupId, year });
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
    const currentMonth = new Date().getMonth() + 1;
    const cumulativeBudgetMap = {};
    for (let [item, monthlyBudget] of Object.entries(budgetMap)) {
      // 貯蓄は対象年が現在年なら現在月まで、過去年なら12ヶ月分
      if (item === '貯蓄') {
        const now = new Date();
        const targetMonth = (year === now.getFullYear()) ? now.getMonth() + 1 : 12;
        cumulativeBudgetMap[item] = monthlyBudget * targetMonth;
      } else {
        cumulativeBudgetMap[item] = monthlyBudget * currentMonth;
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
    const items = await Items.find({ group: groupId });
    for (const i of items) {
      const cfKey = cfMap[i.la_cf];
      if (cfKey && cfKey !== '支出' && totalBudgets[cfKey] !== undefined) {
        totalBudgets[cfKey] += i.budget;
      }
    }
    const exBudgets = await FinanceExBudget.find({ group: groupId, year });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
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
      totalBudgets
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
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          date: {
            $gte: new Date(`${year}-01-01`),
            $lte: new Date(`${year}-12-31`)
          }
        }
      },
      {
        $project: {
          month: { $month: '$date' },
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
      const total = r.total;
      if (!monthlySummary[month][cf]) monthlySummary[month][cf] = 0;
      monthlySummary[month][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[month][expense_item]) {
          monthlyExpensesDetail[month][expense_item] = 0;
        }
        monthlyExpensesDetail[month][expense_item] += total;
      }
    });

    const budgets = await FinanceExBudget.find({ group: groupId, year });
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
    const currentMonth = new Date().getMonth() + 1;
    const cumulativeBudgetMap = {};
    for (let [item, monthlyBudget] of Object.entries(budgetMap)) {
      if (item === '貯蓄') {
        const now = new Date();
        const targetMonth = (year === now.getFullYear()) ? now.getMonth() + 1 : 12;
        cumulativeBudgetMap[item] = monthlyBudget * targetMonth;
      } else {
        cumulativeBudgetMap[item] = monthlyBudget * currentMonth;
      }
    }

    // 追加: Itemsモデルからgroup一致のデータを取得し、各カテゴリ合計を算出
    const items = await Items.find({ group: groupId });
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

    const exBudgets = await FinanceExBudget.find({ group: groupId, year });
    for (const ex of exBudgets) {
      totalBudgets['支出'] += ex.budget || 0;
    }
    // console.log(totalBudgets);

    let groupName = 'グループ';
    if (!req.session.groupName) {
      const group = await Group.findById(groupId);
      if (group) {
        groupName = group.name;
        req.session.groupName = group.name; // 次回以降の表示を高速化
      }
    } else {
      groupName = req.session.groupName;
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
      totalBudgets
    });

  } catch (err) {
    console.error('❌ 年次集計ルートエラー:', err);
    res.status(500).send('年次集計エラー');
  }

//年次集計結果をEXCELで出力（ビューと同じ構成）
router.get('/dashboard/yearly-g-exls', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const result = await Finance.aggregate([
      {
        $match: {
          group: new mongoose.Types.ObjectId(groupId),
          date: {
            $gte: new Date(`${year}-01-01`),
            $lte: new Date(`${year}-12-31`)
          }
        }
      },
      {
        $project: {
          month: { $month: '$date' },
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
      const total = r.total;
      if (!monthlySummary[month][cf]) monthlySummary[month][cf] = 0;
      monthlySummary[month][cf] += total;

      if (cf === '支出' && expense_item) {
        if (!monthlyExpensesDetail[month][expense_item]) {
          monthlyExpensesDetail[month][expense_item] = 0;
        }
        monthlyExpensesDetail[month][expense_item] += total;
      }
    });

    const budgets = await FinanceExBudget.find({ group: groupId, year });
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

    const data = [];

    // ヘッダー
    const header = ['項目', '予算'];
    for (let m = 1; m <= 12; m++) header.push(`${m}月`);
    header.push('年合計');
    data.push(header);

    const cfList = ['収入', '貯蓄', '控除', '支出'];
    cfList.forEach(cf => {
      const row = [cf, ''];
      let yearTotal = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlySummary[m]?.[cf] || 0;
        row.push(val);
        yearTotal += val;
      }
      row.push(yearTotal);
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
    balanceRow.push(yearBalance);
    data.push(balanceRow);

    // 空行
    data.push([]);

    // 支出内訳
    ex_cfs.forEach(item => {
      const row = [item, budgetMap[item] || 0];
      let total = 0;
      for (let m = 1; m <= 12; m++) {
        const val = monthlyExpensesDetail[m]?.[item] || 0;
        row.push(val);
        total += val;
      }
      row.push(total);
      data.push(row);
    });

    const xlsx = require('xlsx');
    const os = require('os');
    const path = require('path');
    const now = new Date();
    const formattedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const formattedTime = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    const outputDir = process.env.NODE_ENV === 'production' ? '/tmp' : path.join(os.homedir(), 'Downloads');
    const outputPath = path.join(outputDir, `yearly_summary_${formattedDate}_${formattedTime}.xlsx`);

    const ws = xlsx.utils.aoa_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Yearly Summary');
    xlsx.writeFile(wb, outputPath);

    res.download(outputPath, `yearly_summary_${formattedDate}_${formattedTime}.xlsx`);
  } catch (err) {
    console.error('❌ 年次Excel出力エラー:', err);
    res.status(500).send('年次Excel出力エラー');
  }
  });
});

//支出計
router.get('/monthly-chart', dashboardController.getMonthlyExpenseData);

// 月別支出明細のグラフ表示
router.get('/monthly-stacked', isLoggedIn, catchAsync(async (req, res) => {
  const groupId = new mongoose.Types.ObjectId(req.session.activeGroupId);
  const selectedYear = parseInt(req.query.year) || new Date().getFullYear();

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
        year: { $year: "$date" }
      }
    },
    {
      $group: {
        _id: "$year"
      }
    },
    {
      $sort: { _id: 1 }
    }
  ]);
  const availableYears = yearsRaw.map(y => y._id);

  // チャート用のデータ生成処理（すでに存在する logic を再利用）
  let labels, datasets;
  if (dashboardController.generateMonthlyStackedChartData) {
    ({ labels, datasets } = await dashboardController.generateMonthlyStackedChartData(groupId, selectedYear));
  } else if (dashboardController.getMonthlyStackedExpenseData) {
    throw new Error('generateMonthlyStackedChartData関数が必要です。');
  } else {
    throw new Error('グラフ用データ生成関数が見つかりません。');
  }

  res.render('dashboard/monthlyStackedChart', {
    labels,
    datasets,
    year: selectedYear,
    availableYears,
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

    const { year, month, item, scope } = req.query;
    const { from, to, payment_type, user } = req.query;

    const y = parseInt(year) || new Date().getFullYear();
    const m = month ? parseInt(month) : undefined;

    // 日付範囲設定
    let dateFilter = {};
    if (from || to) {
      // 明示的な絞り込みが指定されたらそれを優先
      const start = from ? new Date(from) : (m && m >= 1 && m <= 12 ? new Date(y, m - 1, 1) : new Date(`${y}-01-01`));
      const end = to ? new Date(to) : (m && m >= 1 && m <= 12 ? new Date(y, m, 1) : new Date(`${y + 1}-01-01`));
      if (!isNaN(start.getTime())) start.setHours(0, 0, 0, 0);
      if (!isNaN(end.getTime())) end.setHours(23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else {
      // 年または年月の範囲
      if (m && m >= 1 && m <= 12) {
        const start = new Date(y, m - 1, 1);
        const end = new Date(y, m, 1);
        dateFilter = { $gte: start, $lt: end };
      } else {
        const start = new Date(`${y}-01-01`);
        const end = new Date(`${y + 1}-01-01`);
        dateFilter = { $gte: start, $lt: end };
      }
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
        scope, year: y, month: m, item,
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

    const { year, month, item, scope } = req.query;
    const { from, to, payment_type, user, cumulative } = req.query;

    const y = parseInt(year) || new Date().getFullYear();
    const m = month ? parseInt(month) : (new Date().getMonth() + 1);

    // 日付範囲設定
    let dateFilter = {};
    if (from || to) {
      const start = from ? new Date(from) : new Date(y, m - 1, 1);
      const end = to ? new Date(to) : new Date(y, m, 1);
      if (!isNaN(start.getTime())) start.setHours(0, 0, 0, 0);
      if (!isNaN(end.getTime())) end.setHours(23, 59, 59, 999);
      dateFilter = { $gte: start, $lte: end };
    } else if (cumulative) {
      const start = new Date(y, 0, 1);
      const end = new Date(y, m, 1);
      dateFilter = { $gte: start, $lt: end };
    } else {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 1);
      dateFilter = { $gte: start, $lt: end };
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
