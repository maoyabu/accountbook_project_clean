const express = require('express');
const router = express.Router();
const User = require('../models/users');
const Budget = require('../models/finance_ex_budget');
const { isLoggedIn, logAction } = require('../middleware');
const Finance = require('../models/finance');
const RegularEntry = require('../models/finance_regularEntry');
const mongoose = require('mongoose');
const Items = require('../models/finance_items');
const PaymentItem = require('../models/paymentItems');

//selectedの選択肢をここで定義
const la_cfs = ['Please Choice','支出','収入','控除','貯蓄'];
// const ex_cfs = ['Please Choice','副食物費','主食費1','主食費2','調味料','光熱費','住宅・家具費','衣服費','教育費','交際費','教養費','娯楽費','保険・衛生費','職業費','特別費','公共費','車関連費','通信費'];
// const in_items = ['Please Choice','給与','賞与','その他'];
// const dedu_cfs = ['Please Choice','所得税','住民税','健康保険料','厚生年金保険料','介護保険','雇用保険','その他控除'];

//まとめて入力　項目管理画面の表示
router.get('/regular-entry/manage', isLoggedIn, async (req, res) => {
    const groupId = req.session.activeGroupId; // ← 修正済み
    const userId = req.user._id;
    // ex_cfsをfinance_ex_budgetから取得
    const currentYear = new Date().getFullYear();
    const budgetItems = await Budget.find({ group: groupId, year: currentYear }).sort({ display_order: 1 });
    const ex_cfs = ['Please Choice', ...budgetItems.map(item => item.expense_item)];
    
    try {
        const incomeItemDocs = await Items.find({ group: groupId, la_cf: '収入項目' });
        const deduItemDocs = await Items.find({ group: groupId, la_cf: '控除項目' });
        const savingItemDocs = await Items.find({ group: groupId, la_cf: '貯蓄項目' });
        const in_items = incomeItemDocs.length > 0 ? ['Please Choice', ...incomeItemDocs.map(i => i.item)] : ['Please Choice','給与','賞与','その他'];
        const dedu_cfs = deduItemDocs.length > 0 ? ['Please Choice', ...deduItemDocs.map(i => i.item)] : ['Please Choice','所得税','住民税','健康保険料','厚生年金保険料','介護保険','雇用保険','その他控除'];
        const saving_cfs = savingItemDocs.length > 0
          ? ['Please Choice', ...savingItemDocs.map(i => i.item)]
          : ['Please Choice', '貯金', '生命保険', 'その他貯金'];
        const entries = await RegularEntry.find({ group: groupId, user: userId });
        // 🔽 allUsers を取得して渡す
        const allUsers = await User.find({ groups: groupId });
        const paymentItems = await PaymentItem.find({ user: userId, group: groupId, isLive: true }).sort({ display_order: 1 });
        const pay_cfs = paymentItems.map(p => p.paymentItem);
        res.render('finance/regularEntryM', {
             regularEntries: entries,
             entryToEdit: null,
             allUsers,
             pay_cfs,
             la_cfs,
             ex_cfs,
             in_items,
             dedu_cfs,
             saving_cfs
        });
    } catch (err) {
      console.error('❌ まとめて入力の取得中にエラー:', err);
      res.status(500).send('内部エラーが発生しました');
    }
});

//まとめて入力　項目の追加処理
router.post('/regular-entry/create', isLoggedIn, async (req, res) => {
try {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const {
    cf,
    income_item = '',
    expense_item = '',
    dedu_item = '',
    saving_item = '',
    content,
    amount,
    payment_type,
    day
    } = req.body;

    const newEntry = new RegularEntry({
    cf,
    income_item,
    expense_item,
    dedu_item,
    saving_item,    
    content,
    amount,
    payment_type,
    user: userId,
    group: groupId,
    day
    });

    await newEntry.save();
    await logAction({ req, action: 'まとめて入力項目を追加', target: '家計簿' });
    req.flash('success', 'まとめて入力項目を追加しました');
    res.redirect('/matomete/regular-entry/manage');
} catch (err) {
    console.error('❌ まとめて入力の追加中にエラー:', err);
    req.flash('error', '追加に失敗しました');
    res.redirect('/matomete/regular-entry/manage');
}
});

//まとめて入力　項目の削除の処理
router.delete('/regular-entry/:id', isLoggedIn, async (req, res) => {
    try {
      const { id } = req.params;
      await RegularEntry.findByIdAndDelete(id);
      await logAction({ req, action: 'まとめて入力項目の削除', target: '家計簿' });
      req.flash('success', 'まとめて入力項目を削除しました');
      res.redirect('/matomete/regular-entry/manage');
    } catch (err) {
      console.error('❌ まとめて入力項目の削除に失敗:', err);
      req.flash('error', '削除に失敗しました');
      res.redirect('/matomete/regular-entry/manage');
    }
  });

// まとめて入力 項目の編集画面表示
router.get('/regular-entry/edit/:id', isLoggedIn, async (req, res) => {
  const groupId = req.session.activeGroupId;
  const userId = req.user._id;
  const { id } = req.params;
  // ex_cfsをfinance_ex_budgetから取得
  const currentYear = new Date().getFullYear();
  const budgetItems = await Budget.find({ group: groupId, year: currentYear }).sort({ display_order: 1 });
  const ex_cfs = ['Please Choice', ...budgetItems.map(item => item.expense_item)];

  try {
    const incomeItemDocs = await Items.find({ group: groupId, la_cf: '収入項目' });
    const deduItemDocs = await Items.find({ group: groupId, la_cf: '控除項目' });
    const savingItemDocs = await Items.find({ group: groupId, la_cf: '貯蓄項目' });

    const in_items = incomeItemDocs.length > 0 ? ['Please Choice', ...incomeItemDocs.map(i => i.item)] : ['Please Choice','給与','賞与','その他'];
    const dedu_cfs = deduItemDocs.length > 0 ? ['Please Choice', ...deduItemDocs.map(i => i.item)] : ['Please Choice','所得税','住民税','健康保険料','厚生年金保険料','介護保険','雇用保険','その他控除'];
    const saving_cfs = savingItemDocs.length > 0
      ? ['Please Choice', ...savingItemDocs.map(i => i.item)]
      : ['Please Choice', '貯金', '生命保険', 'その他貯金'];
    const entryToEdit = await RegularEntry.findOne({ _id: id, group: groupId, user: userId });
    const allUsers = await User.find({ groups: groupId });
    const paymentItems = await PaymentItem.find({ user: userId, group: groupId, isLive: true }).sort({ display_order: 1 });
    const pay_cfs = paymentItems.map(p => p.paymentItem);

    if (!entryToEdit) {
      req.flash('error', '編集対象の項目が見つかりません');
      return res.redirect('/matomete/regular-entry/manage');
    }

    const entries = await RegularEntry.find({ group: groupId, user: userId });

    res.render('finance/regularEntryM', {
      regularEntries: entries,
      entryToEdit,
      allUsers,
      pay_cfs,
      la_cfs,
      ex_cfs,
      in_items,
      dedu_cfs,
      saving_cfs
    });
  } catch (err) {
    console.error('❌ 編集データの取得中にエラー:', err);
    req.flash('error', '編集データの取得に失敗しました');
    res.redirect('/matomete/regular-entry/manage');
  }
});

// まとめて入力 項目の更新処理
router.post('/regular-entry/update/:id', isLoggedIn, async (req, res, next) => {
  const { id } = req.params;

  // 「confirm」が来たらスキップ（別ルート用）
  if (id === 'confirm') return next();

  if (!mongoose.Types.ObjectId.isValid(id)) {
    req.flash('error', '無効なIDです');
    return res.redirect('/matomete/regular-entry/manage');
  }

  const groupId = req.session.activeGroupId;
  const userId = req.user._id;
  const {
    cf,
    income_item = '',
    expense_item = '',
    dedu_item = '',
    saving_item,
    content,
    amount,
    payment_type,
    day
  } = req.body;

  try {
    const updated = await RegularEntry.findOneAndUpdate(
      { _id: id, group: groupId, user: userId },
      {
        cf,
        income_item,
        expense_item,
        dedu_item,
        saving_item,
        content,
        amount,
        payment_type,
        day
      },
      { new: true }
    );

    if (!updated) {
      req.flash('error', '更新対象の項目が見つかりません');
      return res.redirect('/matomete/regular-entry/manage');
    }
    await logAction({ req, action: 'まとめて入力項目の更新', target: '家計簿' });
    req.flash('success', 'まとめて入力項目を更新しました');
    res.redirect('/matomete/regular-entry/manage');
  } catch (err) {
    console.error('❌ 更新処理中にエラー:', err);
    req.flash('error', '更新に失敗しました');
    res.redirect('/matomete/regular-entry/manage');
  }
});


//まとめて入力の一括登録画面の表示
router.get('/regular-entry/push', isLoggedIn, async (req, res) => {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
  
    try {
      const entries = await RegularEntry.find({ group: groupId, user: userId });
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
  
      res.render('finance/regularEntryP', {
        regularEntries: entries,
        currentYear,
        currentMonth
      });
    } catch (err) {
      console.error('❌ 一括登録画面の取得エラー:', err);
      res.status(500).send('内部エラーが発生しました');
    }
  });

//まとめて入力　一括登録
router.post('/regular-entry/update', isLoggedIn, async (req, res) => {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const { targetMonth, items } = req.body;

    if (!targetMonth || !items) {
        return res.status(400).send("必要な情報が不足しています");
    }
    
    const [yearStr, monthStr] = targetMonth.split('-');
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);

    if (!year || !month || !items) {
        req.flash('error', '必要な情報が不足しています');
        return res.redirect('/matomete/regular-entry/push');
    }
  
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);
  
    const existingEntries = await Finance.find({
        group: groupId,
        user: userId,
        date: { $gte: startOfMonth, $lte: endOfMonth }
    });
  
    // 重複チェックのために key を生成
    const makeKey = (entry) => `${entry.cf}_${entry.content}_${entry.amount}`;
    const existingKeys = new Set(existingEntries.map(makeKey));
  
    const regularEntriesMap = {};
    const allRegulars = await RegularEntry.find({ group: groupId, user: userId });

    allRegulars.forEach(entry => {
    regularEntriesMap[entry._id.toString()] = entry;
    });

    const enrichedItems = items.map(e => {
      const source = regularEntriesMap[e.id];
      if (!source) return null;
      return {
        ...e,
        cf: source.cf,
        content: source.content,
        amount: Number(e.amount)
      };
    }).filter(e => e !== null);
    const duplicates = enrichedItems.filter(e => existingKeys.has(makeKey(e)));
  
    if (duplicates.length > 0) {
        return res.render('finance/regularEntryConfirm', {
            duplicates,
            entries: items,
            year,
            month
        });
    }

    const newEntries = enrichedItems
    .filter(e => !e.skip)
    .map(e => {
        const source = regularEntriesMap[e.id];
        return {
        cf: source.cf,
        income_item: source.income_item || '',
        expense_item: source.expense_item || '',
        dedu_item: source.dedu_item || '',
        saving_item: source.saving_item || '',
        content: source.content,
        amount: Number(e.amount),
        payment_type: source.payment_type,
        user: userId,
        group: groupId,
        date: new Date(Date.UTC(year, month - 1, source.day || 1)),
        month: parseInt(month),
        day: source.day || 1,
        entry_date: new Date(),
        update_date: new Date()
        };
    });
  
    await Finance.insertMany(newEntries);
    await logAction({ req, action: 'まとめて入力実行', target: '家計簿' });
    req.flash('success', 'まとめて入力を完了しました');
    res.redirect('/finance/list');
});

//まとめて入力 重複確認後に重複を無視して登録処理
router.post('/regular-entry/update/confirm', isLoggedIn, async (req, res) => {
    const groupId = req.session.activeGroupId;
    const userId = req.user._id;
    const { year, month, entries, force } = req.body;

    if (!force || !year || !month || !entries) {
      req.flash('error', '必要な情報が不足しています');
      return res.redirect('/matomete/regular-entry/push');
    }

    const yearNum = parseInt(year);
    const monthNum = parseInt(month);
    const startOfMonth = new Date(yearNum, monthNum - 1, 1);
    const endOfMonth = new Date(yearNum, monthNum, 0);

    const parsedEntries = Array.isArray(entries) ? entries : Object.values(entries);
    const regularEntriesMap = {};
    const allRegulars = await RegularEntry.find({ group: groupId, user: userId });
    allRegulars.forEach(entry => {
      regularEntriesMap[entry._id.toString()] = entry;
    });

    const existingEntries = await Finance.find({
      group: groupId,
      user: userId,
      date: { $gte: startOfMonth, $lte: endOfMonth }
    });

    const makeKey = (entry) => `${entry.cf}_${entry.content}_${entry.amount}`;
    const existingByKey = existingEntries.reduce((acc, entry) => {
      const key = makeKey(entry);
      if (!acc[key]) acc[key] = [];
      acc[key].push(entry);
      return acc;
    }, {});

    const buildPayload = (source, amountNum) => {
      const day = source?.day || 1;
      return {
        cf: source?.cf || undefined,
        income_item: source?.income_item || '',
        expense_item: source?.expense_item || '',
        dedu_item: source?.dedu_item || '',
        saving_item: source?.saving_item || '',
        content: source?.content || '',
        amount: amountNum,
        payment_type: source?.payment_type || undefined,
        user: userId,
        group: groupId,
        date: new Date(Date.UTC(yearNum, monthNum - 1, day)),
        month: monthNum,
        day
      };
    };

    const normalizedEntries = parsedEntries
      .map(e => {
        const source = regularEntriesMap[e.id];
        if (!source) return null;
        const amountNum = Number(e.amount);
        const payload = buildPayload(source, amountNum);
        return {
          key: makeKey(payload),
          payload,
          skip: e.skip === '1' || e.skip === 'true'
        };
      })
      .filter(e => e !== null);

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

    await logAction({ req, action: 'まとめて入力を実行', target: '家計簿' });
    req.flash('success', 'まとめて入力を完了しました');
    res.redirect('/finance/list');
  });

module.exports = router;
