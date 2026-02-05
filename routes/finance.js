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
const PaymentItem = require('../models/paymentItems');
const { correctOcrText } = require('../Utils/gptCorrection');
const { convertHeicToJpeg } = require('../Utils/imageUtils');
const cron = require('node-cron');
const Group = require('../models/groups');
const FinanceBudgetNotice = require('../models/finance_budget_notice');
const { sendMail } = require('../Utils/mailer');
const MatometeSetting = require('../models/matomete_setting');
const FinanceBudgetNoticeSetting = require('../models/finance_budget_notice_setting');

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
const getListRedirect = (req) => req.session?.financeListReturn || '/finance/list';

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

const currentYear = new Date().getFullYear();

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
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const daysInMonth = monthEnd.getDate();
    const dayRate = Math.round((today.getDate() / daysInMonth) * 1000) / 10;
    const yearStr = String(today.getFullYear());

    const budgets = await Budget.find({ group: objectId, year: yearStr }).sort({ display_order: 1 }).lean();
    const budgetMap = new Map(budgets.map(b => [b.expense_item || '未分類', Number(b.budget) || 0]));
    const totalBudget = Array.from(budgetMap.values()).reduce((sum, v) => sum + v, 0);

    const expenseAgg = await Finance.aggregate([
      {
        $match: {
          group: objectId,
          user: req.user._id,
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
    });

    const recentFinances = await Finance.find({
      group: objectId,
      user: req.user._id
    })
      .sort({ date: -1, entry_date: -1 })
      .limit(5)
      .populate('user');

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

async function fetchExpenseItemsByYear(groupId, year) {
  const yearStr = year ? String(year) : String(new Date().getFullYear());
  const budgetItems = await Budget.find({ group: groupId, year: yearStr }).sort({ display_order: 1 });
  if (budgetItems.length === 0) {
    return ['Please Choice', ...ex_cfs];
  }
  return ['Please Choice', ...budgetItems.map(item => item.expense_item)];
}

async function loadCfItems(req, year) {
  const groupId = req.session.activeGroupId;
  const targetYear = year ? String(year) : String(new Date().getFullYear());
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

//新規登録　表示用
router.get('/entry', isLoggedIn, async(req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }
    const yearForItems = extractYearFromDate(req.query?.date) || currentYear;
    await loadCfItems(req, yearForItems);
    // MongoDBからデータを取得（activeGroupIDで絞り込み）
    const allUsers = await FinanceUser.find({ groups: activeGroupId });
    const ex_cfs = await fetchExpenseItemsByYear(activeGroupId, yearForItems);

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
        duplicateWarning: false
    });
});

//新規でデータを登録する
router.post('/entry', upload.single('receiptImage'), catchAsync(async (req, res, next) => {
    // レシート画像のパスをログ出力
    if (req.file) {
      // console.log('アップロードされたレシート画像パス:', req.file.path);
    }
    const activeGroupId = req.session.activeGroupId;
    const yearForItems = extractYearFromDate(req.body?.finance?.date) || currentYear;
    await loadCfItems(req, yearForItems);
    const { finance } = req.body;
    const nextAction = Array.isArray(req.body.nextAction) ? req.body.nextAction[0] : req.body.nextAction;
    const allUsers = await FinanceUser.find({ groups: req.session.activeGroupId });
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
            duplicateWarning: false
        });
    }

    if (!finance) {
        req.flash('error', 'フォームデータが送信されていません');
        return res.redirect('finance/entry');
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
        duplicateWarning: true
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
        tags: Array.isArray(req.body.finance.tags)
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
    const tagItems = req.body.tagItems || [];
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

    newFinance.tags = tags;

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
        cloneData.income_item = '';
        cloneData.expense_item = '';
        cloneData.dedu_item = '';
        cloneData.saving_item = '';

        const duplicateCloneQuery = buildDuplicateQuery(cloneData);
        const duplicateCloneEntry = await Finance.findOne(duplicateCloneQuery);
        if (duplicateCloneEntry && req.body.confirmDuplicate !== '1') {
            const formattedDate = duplicateCloneEntry.date.toISOString().split('T')[0];
            const formattedEntryDate = toJST(new Date(duplicateCloneEntry.entry_date)).toLocaleString('ja-JP');
            const formattedUpdateDate = toJST(new Date(duplicateCloneEntry.update_date || duplicateCloneEntry.entry_date)).toLocaleString('ja-JP');
            return res.render('finance/edit', {
                page: 'entry',
                errors: {},
                finance: duplicateCloneEntry,
                formattedDate,
                formattedEntryDate,
                formattedUpdateDate,
                duplicateMessage,
                duplicateWarning: true,
                la_cfs,
                ex_cfs,
                in_items,
                dedu_cfs,
                saving_cfs,
                pay_cfs,
                whos,
                allUsers
            });
        }

        const duplicatedFinance = new Finance(cloneData);

        await duplicatedFinance.save(); // ここ！保存する！！

        const formattedDate = duplicatedFinance.date.toISOString().split('T')[0];
        const formattedEntryDate = toJST(new Date()).toLocaleString('ja-JP');
        const formattedUpdateDate = toJST(new Date()).toLocaleString('ja-JP');
         

        return res.render('finance/edit', {
            page: 'entry',
            errors: {},
            finance: duplicatedFinance,
            formattedDate,
            formattedEntryDate,
            formattedUpdateDate,
            duplicateMessage,
            la_cfs,
            ex_cfs,
            in_items,
            dedu_cfs,
            saving_cfs,
            pay_cfs,
            whos,
            allUsers
        });
    }

    await logAction({ req, action: '登録', target: '家計簿' });
    res.redirect(getListRedirect(req));
}));

// 検索画面の表示
router.get('/search', isLoggedIn, async (req, res) => {
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    req.flash('error', 'アクティブなグループが選択されていません');
    return res.redirect('/group_list');
  }

  await loadCfItems(req);

  // ex_cfsをfinance_ex_budgetから取得
  const currentYear = new Date().getFullYear();
  const budgetItems = await Budget.find({ group: activeGroupId, year: currentYear });
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
    const { date, date2, cf, expense_item, income_item, dedu_item, saving_item, payment_type, user, keyword } = req.body;

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
    await loadCfItems(req);
    const currentYear = new Date().getFullYear();
    const budgetItems = await Budget.find({ group: activeGroupId, year: currentYear });
    const ex_cfs = budgetItems.map(item => item.expense_item);

    res.render('finance/search_results', {
        finances,
        count,
        page: 'search',
        currentUser,  // ← これを追加！
        enableFilterBar: true,
        filters: {
          from: date || '', to: date2 || '',
          payment_type: (payment_type && payment_type !== 'Please Choice') ? payment_type : 'Please Choice',
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
        saving_cfs
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
  await loadCfItems(req);
  const currentYear = new Date().getFullYear();
  const budgetItems = await Budget.find({ group: activeGroupId, year: currentYear });
  const ex_cfs = budgetItems.map(item => item.expense_item);

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
      keyword: keyword || ''
    },
    pay_cfs: mergedPayCfs,
    whos: group.members,
    la_cfs,
    ex_cfs,
    in_items,
    dedu_cfs,
    saving_cfs
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
    const selectedKeyword = req.query.keyword || '';
    const sortCriteria = sortOrder === 'update_date'
      ? { update_date: -1 }
      : { date: -1 };

    const baseCondition = { group: objectId, user: req.user._id };
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
    if (selectedKeyword && selectedKeyword.trim()) {
      andConditions.push({ content: { $regex: escapeRegExp(selectedKeyword.trim()), $options: 'i' } });
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
        keyword: selectedKeyword
      },
      filterOptions: {
        cfs: cfOptions,
        categories: categoryOptions,
        payments: paymentOptions
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
    const activeGroupId = req.session.activeGroupId;

    //ObjectId の形式チェック
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', '無効なIDです');
        return res.redirect('/finance/list');
    }
    const finance = await Finance.findById(id).populate('user');
    const yearForItems = extractYearFromDate(finance?.date) || currentYear;
    await loadCfItems(req, yearForItems);
    // グループごとの貯蓄項目を取得
    const savingItems = await fetchItemsByYear(activeGroupId, '貯蓄項目', yearForItems);
    let saving_cfs = ['Please Choice', ...savingItems.map(i => i.item)];
    // 追加: 編集対象の項目が存在しない場合も反映できるようにする
    if (!saving_cfs.includes(finance.saving_item) && finance.saving_item) {
        saving_cfs.push(finance.saving_item);
    }
    // ex_cfsをfinance_ex_budgetから取得
    const ex_cfs = await fetchExpenseItemsByYear(activeGroupId, yearForItems);
    
    if (!finance) {
        req.flash('error', 'データが存在しません');
        res.redirect('/finance/list');
        return;
    }

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
    const allUsers = await FinanceUser.find({ groups: activeGroupId });
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
        in_items,
        dedu_cfs,
        saving_cfs, // ← 新しく取得したsaving_cfsを利用
        pay_cfs: global.pay_cfs,
        whos,
        allUsers,
        currentUser: req.user,
        duplicateWarning: req.query.duplicateWarning === '1'
    });
}));

// JST に変換する関数
function getJSTDate() {
    const now = new Date();
    return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

//家計簿編集画面の更新
router.put('/:id', isLoggedIn, catchAsync(async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    const { id } = req.params;  // これでURLパラメータのidを取得
    const { finance } = req.body;
    const nextAction = Array.isArray(req.body.nextAction) ? req.body.nextAction[0] : req.body.nextAction;
    const { date, cf, amount, payment_type, user } = finance;
    const allUsers = await FinanceUser.find(); // もしくは必要なユーザー情報取得

    const yearForItems = extractYearFromDate(date) || currentYear;
    await loadCfItems(req, yearForItems);
    const ex_cfs = await fetchExpenseItemsByYear(activeGroupId, yearForItems);
    const savingItems = await fetchItemsByYear(activeGroupId, '貯蓄項目', yearForItems);
    let saving_cfs = ['Please Choice', ...savingItems.map(i => i.item)];
    if (!saving_cfs.includes(finance.saving_item) && finance.saving_item) {
        saving_cfs.push(finance.saving_item);
    }

    let errors = {};

    // 各項目のバリデーションをチェック
    if (!date) errors.date = "日付は必須です";
    if (!cf || cf === 'Please Choice') errors.cf = "収支区分は必須です。まだ登録は完了していません。";  // cf のチェック
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
    if (!amount || amount === '') errors.amount = "金額は必須です";  // amount の空チェック
    if (!payment_type || payment_type === 'Please Choice') errors.payment_type = "支払種別は必須です、まだ登録は完了してません。";
    if (!user || user === 'Please Choice') errors.user = "対象者は必須です";

    //エラーがあればそのままビューに戻す
    if (Object.keys(errors).length > 0) {
        return res.render('finance/edit', {
            page: 'edit',
            errors,
            finance: { ...finance, _id: id, tags: req.body.finance.tags || [] },
            formattedDate: date,
            formattedEntryDate: '',
            formattedUpdateDate: '',
            la_cfs,
            ex_cfs,
            in_items,
            dedu_cfs,
            saving_cfs,
            pay_cfs,
            whos,
            allUsers
        });
    }

    if (finance.cf === 'Please Choice') finance.cf = '';
    if (finance.payment_type === 'Please Choice') finance.payment_type = '';
    if (finance.user === 'Please Choice') finance.user = '';
    if (finance.income_item === 'Please Choice') finance.income_item = '';
    if (finance.expense_item === 'Please Choice') finance.expense_item = '';
    if (finance.dedu_item === 'Please Choice') finance.dedu_item = '';

    // `date` から month, day を抽出
    const dateObj = new Date(finance.date);
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();

    // 既存のFinanceドキュメントを取得
    const financeDoc = await Finance.findById(id);
    if (!financeDoc) {
        req.flash('error', 'データが存在しません');
        return res.status(404).send("データが見つかりません");
    }

    // タグ情報をtagItemsから取得してtags配列を構築
    let tags = [];
    if (req.body.tagItems) {
        // tagItemsが配列またはオブジェクトのいずれか
        const tagSource = Array.isArray(req.body.tagItems)
            ? req.body.tagItems
            : Object.values(req.body.tagItems);
        tags = tagSource
            .filter(item => item && item.name)
            .map(item => ({
                name: item.name,
                category: item.category || '',
                price: Number(item.price) || 0
            }));
    }

    // 更新
    Object.assign(financeDoc, {
        ...finance,
        saving_item: finance.cf === '貯蓄' && finance.saving_item !== 'Please Choice' ? finance.saving_item : '',
        income_item: finance.income_item === 'Please Choice' || !finance.income_item ? '' : finance.income_item,
        expense_item: finance.expense_item === 'Please Choice' || !finance.expense_item ? '' : finance.expense_item,
        dedu_item: finance.dedu_item === 'Please Choice' || !finance.dedu_item ? '' : finance.dedu_item,
        cf: finance.cf === 'Please Choice' ? '' : finance.cf,
        payment_type: finance.payment_type === 'Please Choice' ? '' : finance.payment_type,
        user: finance.user === 'Please Choice' ? '' : finance.user,
        group: req.session.activeGroupId,
        memo: finance.memo || '',
        update_date: getJSTDate(),
        month,
        day,
        tags // ← ここでtagItemsから抽出したtagsをセット
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
        clone.entry_date = getJSTDate();
        clone.update_date = getJSTDate();
        clone.income_item = '';
        clone.expense_item = '';
        clone.dedu_item = '';
        clone.saving_item = '';

        const duplicateCloneQuery = buildDuplicateQuery(clone);
        const duplicateCloneEntry = await Finance.findOne(duplicateCloneQuery);
        if (duplicateCloneEntry && req.body.confirmDuplicate !== '1') {
            const formattedDate = duplicateCloneEntry.date.toISOString().split('T')[0];
            const currentUser = await FinanceUser.findById(req.user._id).populate('groups');
            const allUsers = await FinanceUser.find({ groups: req.session.activeGroupId });
            return res.render('finance/edit', {
                page: 'entry',
                errors: {},
                finance: { ...duplicateCloneEntry.toObject(), tags: duplicateCloneEntry.tags || [] },
                formattedDate,
                formattedEntryDate: duplicateCloneEntry.entry_date.toLocaleString('ja-JP'),
                formattedUpdateDate: (duplicateCloneEntry.update_date || duplicateCloneEntry.entry_date).toLocaleString('ja-JP'),
                duplicateMessage,
                duplicateWarning: true,
                la_cfs,
                ex_cfs,
                in_items,
                dedu_cfs,
                saving_cfs,
                pay_cfs,
                whos,
                allUsers,
                currentUser
            });
        }
        const newFinance = new Finance(clone);
        await newFinance.save();
        const formattedDate = newFinance.date.toISOString().split('T')[0];
        const currentUser = await FinanceUser.findById(req.user._id).populate('groups');
        const allUsers = await FinanceUser.find({ groups: req.session.activeGroupId });
        return res.render('finance/edit', {
            page: 'entry',
            errors: {},
            finance: { ...newFinance.toObject(), tags: newFinance.tags || [] },
            formattedDate,
            formattedEntryDate: newFinance.entry_date.toLocaleString('ja-JP'),
            formattedUpdateDate: newFinance.update_date.toLocaleString('ja-JP'),
            duplicateMessage,
            la_cfs,
            ex_cfs,
            in_items,
            dedu_cfs,
            saving_cfs,
            pay_cfs,
            whos,
            allUsers,
            currentUser
        });
    }

    req.flash('success', '更新に成功しました');
    await logAction({ req, action: '更新', target: '家計簿' });
    res.redirect(getListRedirect(req)); // 更新後に一覧ページへリダイレクト
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
            saving_item: ''
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
        res.redirect(`/finance/${newFinance._id}/edit`);
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

// 予算到達率メール通知（毎時、前日までの実績で判定）
cron.schedule('0 * * * *', async () => {
  try {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const monthStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1, 0, 0, 0, 0);
    const monthEnd = new Date(yesterday.getFullYear(), yesterday.getMonth() + 1, 0, 23, 59, 59, 999);
    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);
    const daysInMonth = monthEnd.getDate();
    const dayRate = Math.round((yesterday.getDate() / daysInMonth) * 1000) / 10;
    const monthKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}`;
    const yearStr = String(yesterday.getFullYear());

    const users = await FinanceUser.find({
      financeBudgetNoticeEnabled: true,
      isMail: { $ne: false }
    }).populate('groups');

    for (const user of users) {
      if (!user.email) continue;
      if (user.services && user.services.finance === false) continue;

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
        const noticeSetting = await FinanceBudgetNoticeSetting.findOne({ group: groupId });
        const noticeHour = Number.isInteger(noticeSetting?.noticeHour) ? noticeSetting.noticeHour : 8;
        if (today.getHours() !== noticeHour) continue;

        const budgets = await Budget.find({ group: groupId, year: yearStr }).lean();
        if (!budgets || budgets.length === 0) continue;

        const totalBudget = budgets.reduce((sum, b) => sum + (Number(b.budget) || 0), 0);

        const expenseAgg = await Finance.aggregate([
          {
            $match: {
              group: groupId,
              cf: '支出',
              date: { $gte: monthStart, $lte: endOfYesterday }
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
          if (actualValue <= budgetValue) return;
          const threshold = 100;
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



//予算関連ルート
//予算設定のトップ画面表示
router.get('/budget', isLoggedIn, (req, res) => {
  const activeGroupId = req.session.activeGroupId;
  const selectedYear = new Date().getFullYear(); // 現在の年を初期値に
  Promise.all([
    MatometeSetting.findOne({ group: activeGroupId }),
    FinanceBudgetNoticeSetting.findOne({ group: activeGroupId })
  ]).then(([matometeSetting, noticeSetting]) => {
    res.render('finance/budgetTop', {
      activeGroupId,
      selectedYear,
      page: 'budget',
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
          : 8
      }
    });
  });
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
    const to = req.body.test_email;
    if (!to) {
      req.flash('error', '送信先メールアドレスを入力してください');
      return res.redirect('/finance/budget');
    }
    await sendMail({
      to,
      subject: '【家計簿】予算の到達状況（テスト送信）',
      templateName: 'budgetNotice',
      templateData: {
        name: req.user.displayname || req.user.username,
        month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
        dayRate: 50,
        groups: [
          {
            groupName: 'テストグループ',
            totalRate: 75,
            alerts: [
              {
                targetLabel: '副食物費',
                actualRate: 120,
                budget: 5000,
                actual: 6000,
                over: true
              }
            ]
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
    const groupId = req.session.activeGroupId;
    const year = req.query.year;
    if (!groupId) {
      return res.status(400).json({ error: 'groupId が不足しています' });
    }
    if (!year) {
      return res.status(400).json({ error: 'year が不足しています' });
    }

    const ex_cfs = await fetchExpenseItemsByYear(groupId, year);
    const incomeItems = await fetchItemsByYear(groupId, '収入項目', year);
    const deduItems = await fetchItemsByYear(groupId, '控除項目', year);
    const savingItems = await fetchItemsByYear(groupId, '貯蓄項目', year);

    const in_items = incomeItems.length > 0
      ? ['Please Choice', ...incomeItems.map(i => i.item)]
      : [...defaultInItems];
    const dedu_cfs = deduItems.length > 0
      ? ['Please Choice', ...deduItems.map(i => i.item)]
      : [...defaultDeduCfs];
    const saving_cfs = savingItems.length > 0
      ? ['Please Choice', ...savingItems.map(i => i.item)]
      : [...defaultSavingCfs];

    res.json({
      ex_cfs,
      in_items,
      dedu_cfs,
      saving_cfs
    });
  } catch (err) {
    console.error('❌ 年度別区分取得エラー:', err);
    res.status(500).json({ error: '内部エラーが発生しました' });
  }
});

// 年度予算登録画面の表示
router.post('/budget/setup', isLoggedIn, async (req, res) => {
  try {
    const { groupId, year } = req.body;
    if (!groupId || !year) {
      return res.status(400).send('groupId または year が不足しています');
    }

    const existingBudgets = await Budget.find({ group: groupId, year });

    const budgetItems = existingBudgets.length > 0
      ? existingBudgets
      : ex_cfs.map((item, i) => ({
          display_order: i + 1,
          expense_item: item,
          budget: 0
        }));

    let incomeItems = await Items.find({ group: groupId, la_cf: '収入項目', year }).sort({ display_order: 1 });
    if (incomeItems.length === 0) {
      incomeItems = await Items.find({ group: groupId, la_cf: '収入項目', year: { $exists: false } }).sort({ display_order: 1 });
    }
    let deduItems = await Items.find({ group: groupId, la_cf: '控除項目', year }).sort({ display_order: 1 });
    if (deduItems.length === 0) {
      deduItems = await Items.find({ group: groupId, la_cf: '控除項目', year: { $exists: false } }).sort({ display_order: 1 });
    }
    let savingItems = await Items.find({ group: groupId, la_cf: '貯蓄項目', year }).sort({ display_order: 1 });
    if (savingItems.length === 0) {
      savingItems = await Items.find({ group: groupId, la_cf: '貯蓄項目', year: { $exists: false } }).sort({ display_order: 1 });
    }

    // res.render() に渡しているか確認
    res.render('finance/budget', {
    groupId,
    year,
    budgetItems,
    incomeItems,
    deduItems,
    savingItems,
    layout: false
    });
  } catch (err) {
    console.error('❌ /budget/setup でエラー:', err);
    res.status(500).send('内部エラーが発生しました');
  }
});

//支出項目、収入・控除・貯蓄項目　予算の保存
router.post('/budget/save', isLoggedIn, async (req, res) => {
  const { groupId, year, items, incomeItems, deduItems, savingItems } = req.body;

  // 既存削除（上書き保存）
  await Budget.deleteMany({ group: groupId, year });
  await Items.deleteMany({ group: groupId, year });

  // 支出項目
  const entries = Array.isArray(items) ? items : Object.values(items);
  const newEntries = entries.map((item, index) => ({
      display_order: item.display_order || index + 1,
      group: groupId,
      year,
      expense_item: item.expense_item,
      budget: Number(item.budget),
      entry_date: new Date(),
      update_date: new Date()
  }));
  await Budget.insertMany(newEntries);

  // 収入・控除・貯蓄項目の登録
  const allItems = [];

  const incomeArray = Array.isArray(incomeItems) ? incomeItems : Object.values(incomeItems || {});
  incomeArray.forEach((item, idx) => {
    if (item.item && item.item.trim()) {
      allItems.push({
        display_order: item.display_order || idx + 1,
        group: groupId,
        year,
        la_cf: '収入項目',
        item: item.item.trim(),
        budget: Number(item.budget),
        entry_date: new Date(),
        update_date: new Date()
      });
    }
  });

  const deduArray = Array.isArray(deduItems) ? deduItems : Object.values(deduItems || {});
  deduArray.forEach((item, idx) => {
    if (item.item && item.item.trim()) {
      allItems.push({
        display_order: item.display_order || idx + 1,
        group: groupId,
        year,
        la_cf: '控除項目',
        item: item.item.trim(),
        budget: Number(item.budget),
        entry_date: new Date(),
        update_date: new Date()
      });
    }
  });
// 貯蓄項目の登録
    const savingArray = Array.isArray(savingItems) ? savingItems : Object.values(savingItems || {});
    savingArray.forEach((item, idx) => {
        if (item.item && item.item.trim()) {
        allItems.push({
            display_order: item.display_order || idx + 1,
            group: groupId,
            year,
            la_cf: '貯蓄項目',
            item: item.item.trim(),
            budget: Number(item.budget),
            entry_date: new Date(),
            update_date: new Date()
        });
        }
    });

  if (allItems.length > 0) {
    await Items.insertMany(allItems);
  }

  req.flash('success', '予算を保存しました');
  await logAction({ req, action: '保存', target: '年度予算' });
  const [matometeSetting, noticeSetting] = await Promise.all([
    MatometeSetting.findOne({ group: groupId }),
    FinanceBudgetNoticeSetting.findOne({ group: groupId })
  ]);
  res.render('finance/budgetTop', {
      activeGroupId: groupId,
      selectedYear: year,
      page: 'budget',
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
          : 8
      }
  });
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
    await loadCfItems(req);
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
