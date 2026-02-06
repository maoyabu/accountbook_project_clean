const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const { isLoggedIn } = require('../middleware');
const Finance = require('../models/finance');
const Eventcal = require('../models/eventcal');
const Eventcal_events = require('../models/eventcal_events');
require('../models/menu/menu');
const MenuDo = require('../models/menu/menuDo');
const { extractDiaryTags } = require('../Utils/diaryTags');

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
    const monthStart = dayjs(selectedDate).startOf('month').toDate();
    const monthEnd = dayjs(selectedDate).endOf('month').toDate();
    monthStart.setHours(0, 0, 0, 0);
    monthEnd.setHours(23, 59, 59, 999);

    const financeDocs = await Finance.find({
      user: req.user._id,
      date: { $gte: start, $lte: end }
    })
      .populate('group')
      .sort({ entry_date: 1 });

    const diaryDocs = await Eventcal.find({
      user: req.user._id,
      date: { $gte: start, $lte: end }
    })
      .populate('group')
      .sort({ entry_date: 1 });

    const diaryDocsMonth = await Eventcal.find({
      user: req.user._id,
      date: { $gte: monthStart, $lte: monthEnd }
    }).select('date title summary content tags');

    const menuDoDocs = await MenuDo.find({
      recordedBy: req.user._id,
      date: { $gte: start, $lte: end }
    })
      .populate('menu')
      .populate('group')
      .sort({ mealType: 1, createdAt: 1 });

    const events = await Eventcal_events.find({
      user: req.user._id,
      group: groupId
    }).sort({ display_order: 1, entry_date: 1 });

    const financeGroupsMap = new Map();
    financeDocs.forEach((entry) => {
      const groupId = entry.group?._id?.toString() || 'unknown';
      const groupName = entry.group?.group_name || 'グループ未設定';
      if (!financeGroupsMap.has(groupId)) {
        financeGroupsMap.set(groupId, { groupId, groupName, entries: [] });
      }
      financeGroupsMap.get(groupId).entries.push({
        id: entry._id,
        cf: entry.cf,
        category: resolveFinanceCategory(entry),
        content: entry.content || '',
        amount: entry.amount || 0,
        amountFormatted: Number(entry.amount || 0).toLocaleString('ja-JP'),
        payment_type: entry.payment_type || ''
      });
    });

    const financeOrder = ['収入', '貯蓄', '控除', '支出'];
    const financeOrderIndex = new Map(financeOrder.map((cf, idx) => [cf, idx]));
    financeGroupsMap.forEach((group) => {
      group.entries.sort((a, b) => {
        const ai = financeOrderIndex.has(a.cf) ? financeOrderIndex.get(a.cf) : financeOrder.length;
        const bi = financeOrderIndex.has(b.cf) ? financeOrderIndex.get(b.cf) : financeOrder.length;
        if (ai !== bi) return ai - bi;
        return 0;
      });
    });

    const eventOrderIndex = new Map();
    events.forEach((ev, idx) => {
      const key = ev.event || '';
      if (!eventOrderIndex.has(key)) {
        eventOrderIndex.set(key, Number.isInteger(ev.display_order) ? ev.display_order : idx + 1);
      }
    });

    const diaryGroupsMap = new Map();
    const diaryEntries = [];
    const diaryTagSummaryMap = new Map();
    for (const entry of diaryDocs) {
      const groupId = entry.group?._id?.toString() || 'unknown';
      const groupName = entry.group?.group_name || 'グループ未設定';
      if (!diaryGroupsMap.has(groupId)) {
        diaryGroupsMap.set(groupId, { groupId, groupName, entries: [] });
      }
      const tagSource = [entry.title, entry.summary, entry.content].filter(Boolean).join(' ');
      const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags : await extractDiaryTags(tagSource);
      const diaryEntry = {
        id: entry._id,
        date: dayjs(entry.date).format('YYYY-MM-DD'),
        item: entry.item || '',
        event: entry.event || '',
        rate: entry.rate || 0,
        title: entry.title || '',
        content: entry.content || '',
        summary: entry.summary || '',
        share: Boolean(entry.share),
        tags
      };
      diaryGroupsMap.get(groupId).entries.push(diaryEntry);
      diaryEntries.push(diaryEntry);
      tags.forEach((tag) => {
        if (!tag?.name) return;
        const current = diaryTagSummaryMap.get(tag.name) || 0;
        diaryTagSummaryMap.set(tag.name, current + (Number(tag.score) || 0));
      });
    }

    diaryGroupsMap.forEach((group) => {
      group.entries.sort((a, b) => {
        const ai = eventOrderIndex.has(a.event) ? eventOrderIndex.get(a.event) : Number.MAX_SAFE_INTEGER;
        const bi = eventOrderIndex.has(b.event) ? eventOrderIndex.get(b.event) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return 0;
      });
    });

    const monthlyTagCountMap = new Map();
    const monthlyDiaryEntries = [];
    for (const entry of diaryDocsMonth) {
      const tagSource = [entry.title, entry.summary, entry.content].filter(Boolean).join(' ');
      const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags : await extractDiaryTags(tagSource);
      monthlyDiaryEntries.push({
        id: entry._id,
        date: dayjs(entry.date).format('YYYY-MM-DD'),
        title: entry.title || '',
        summary: entry.summary || '',
        content: entry.content || '',
        tags: tags.map(t => t?.name).filter(Boolean)
      });
      tags.forEach((tag) => {
        if (!tag?.name) return;
        const increment = Number.isFinite(Number(tag.score)) ? Number(tag.score) : 1;
        monthlyTagCountMap.set(tag.name, (monthlyTagCountMap.get(tag.name) || 0) + increment);
      });
    }
    const monthlyTagSummary = Array.from(monthlyTagCountMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 30);

    const mealLabelMap = {
      breakfast: '朝食',
      lunch: '昼食',
      dinner: '夕飯'
    };

    const mealGroupsMap = new Map();
    menuDoDocs.forEach((entry) => {
      const menu = entry.menu || {};
      const groupId = entry.group?._id?.toString() || 'unknown';
      const groupName = entry.group?.group_name || 'グループ未設定';
      if (!mealGroupsMap.has(groupId)) {
        mealGroupsMap.set(groupId, {
          groupId,
          groupName,
          meals: { breakfast: [], lunch: [], dinner: [] }
        });
      }
      const mealEntry = {
        id: entry._id,
        mealType: entry.mealType,
        mealLabel: mealLabelMap[entry.mealType] || entry.mealType,
        name: menu.name || '',
        junle: menu.junle || '',
        kind: menu.kind || '',
        imageUrl: menu.imageUrl || ''
      };
      const bucket = mealGroupsMap.get(groupId).meals[entry.mealType];
      if (bucket) bucket.push(mealEntry);
    });

    const diaryTagSummary = Array.from(diaryTagSummaryMap.entries())
      .map(([name, score]) => ({ name, score: Math.round(score * 100) / 100 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    return res.render('allaboutme/eventcal2', {
      selectedDate: dayjs(start).format('YYYY-MM-DD'),
      financeGroups: Array.from(financeGroupsMap.values()),
      diaryGroups: Array.from(diaryGroupsMap.values()),
      diaryEntries,
      diaryTagSummary,
      monthlyTagSummary,
      monthlyDiaryEntries,
      mealGroups: Array.from(mealGroupsMap.values()),
      events
    });
  } catch (error) {
    console.error('MyDiary取得エラー:', error);
    req.flash('error', 'MyDiaryの取得に失敗しました');
    return res.redirect('/myTop/top');
  }
});

module.exports = router;
