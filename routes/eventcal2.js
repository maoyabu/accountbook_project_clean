const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const { isLoggedIn } = require('../middleware');
const Finance = require('../models/finance');
const Eventcal = require('../models/eventcal');

const getSelectedDate = (rawDate) => {
  if (!rawDate) return new Date();
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
};

const buildDayRange = (date) => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const resolveFinanceCategory = (entry) => {
  switch (entry.cf) {
    case '収入':
      return entry.income_item || '';
    case '支出':
      return entry.expense_item || '';
    case '控除':
      return entry.dedu_item || '';
    case '貯蓄':
      return entry.saving_item || '';
    default:
      return '';
  }
};

router.get('/eventcal2', isLoggedIn, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/login');
    }

    const selectedDate = getSelectedDate(req.query.date);
    const { start, end } = buildDayRange(selectedDate);

    const financeDocs = await Finance.find({
      user: req.user._id,
      group: groupId,
      date: { $gte: start, $lte: end }
    }).sort({ entry_date: 1 });

    const diaryDocs = await Eventcal.find({
      user: req.user._id,
      group: groupId,
      date: { $gte: start, $lte: end }
    }).sort({ entry_date: 1 });

    const financeEntries = financeDocs.map((entry) => ({
      id: entry._id,
      cf: entry.cf,
      category: resolveFinanceCategory(entry),
      content: entry.content || '',
      amount: entry.amount || 0,
      amountFormatted: Number(entry.amount || 0).toLocaleString('ja-JP'),
      payment_type: entry.payment_type || ''
    }));

    const diaryEntries = diaryDocs.map((entry) => ({
      id: entry._id,
      event: entry.event || '',
      rate: entry.rate || 0,
      content: entry.content || ''
    }));

    return res.render('allaboutme/eventcal2', {
      selectedDate: dayjs(start).format('YYYY-MM-DD'),
      financeEntries,
      diaryEntries
    });
  } catch (error) {
    console.error('MyDialy取得エラー:', error);
    req.flash('error', 'MyDialyの取得に失敗しました');
    return res.redirect('/myTop/top');
  }
});

module.exports = router;
