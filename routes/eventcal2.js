const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const { isLoggedIn } = require('../middleware');
const Finance = require('../models/finance');
const Eventcal = require('../models/eventcal');
const Eventcal_events = require('../models/eventcal_events');
const Group = require('../models/groups');
require('../models/menu/menu');
const MenuDo = require('../models/menu/menuDo');
const WeeklyMenuPlan = require('../models/menu/weeklyMenuPlan');
const { extractDiaryTags } = require('../Utils/diaryTags');
const Eventcal_settings = require('../models/eventcal_settings');

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
    }).select('date item event title summary content tags');

    const menuDoDocs = await MenuDo.find({
      recordedBy: req.user._id,
      date: { $gte: start, $lte: end }
    })
      .populate({
        path: 'menu',
        populate: {
          path: 'setMenus',
          select: 'name imageUrl'
        }
      })
      .populate('group')
      .sort({ mealType: 1, createdAt: 1 });

    const selectedDateKey = dayjs(selectedDate).format('YYYY-MM-DD');
    const mealCommentMap = new Map();
    const commentGroupIds = new Set(
      menuDoDocs
        .map(entry => entry.group?._id?.toString())
        .filter(Boolean)
    );
    if (groupId) commentGroupIds.add(String(groupId));
    if (commentGroupIds.size > 0) {
      const targetDate = new Date(selectedDate);
      targetDate.setHours(0, 0, 0, 0);
      const plans = await WeeklyMenuPlan.find({
        group: { $in: Array.from(commentGroupIds) },
        weekStart: { $lte: targetDate },
        weekEnd: { $gte: targetDate }
      }).select('group dayComments').lean();

      plans.forEach((plan) => {
        const planGroupId = plan.group?.toString();
        if (!planGroupId) return;
        const dayComment = (plan.dayComments || []).find(dc => (
          dayjs(dc.date).format('YYYY-MM-DD') === selectedDateKey
        ));
        if (!dayComment) return;
        mealCommentMap.set(planGroupId, {
          comment: dayComment.comment || ''
        });
      });
    }

    const allEvents = await Eventcal_events.find({
      user: req.user._id,
      group: groupId
    }).sort({ display_order: 1, entry_date: 1 });
    const events = allEvents.filter(ev => ev.showInEntryDropdown !== false);
    const excludedTagEventKeySet = new Set(
      allEvents
        .filter(ev => ev.excludeFromTags)
        .map(ev => `${ev.item}||${ev.event}`)
    );
    const settings = await Eventcal_settings.findOne({
      user: req.user._id,
      group: groupId
    }).select('excludeWords');
    const excludeWordSet = new Set(
      (settings?.excludeWords || []).map(w => String(w).trim().toLowerCase()).filter(Boolean)
    );

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
    allEvents.forEach((ev, idx) => {
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
      const eventKey = `${entry.item || ''}||${entry.event || ''}`;
      const excludeFromTags = excludedTagEventKeySet.has(eventKey);
      const tagSource = [entry.title, entry.summary, entry.content].filter(Boolean).join(' ');
      const rawTags = Array.isArray(entry.tags) && entry.tags.length > 0
        ? entry.tags
        : await extractDiaryTags(tagSource, { excludeWords: settings?.excludeWords });
      const tags = excludeFromTags
        ? []
        : rawTags.filter(t => !excludeWordSet.has(String(t?.name || '').trim().toLowerCase()));
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
      const eventKey = `${entry.item || ''}||${entry.event || ''}`;
      const excludeFromTags = excludedTagEventKeySet.has(eventKey);
      const tagSource = [entry.title, entry.summary, entry.content].filter(Boolean).join(' ');
      const rawTags = Array.isArray(entry.tags) && entry.tags.length > 0
        ? entry.tags
        : await extractDiaryTags(tagSource, { excludeWords: settings?.excludeWords });
      const tags = excludeFromTags
        ? []
        : rawTags.filter(t => !excludeWordSet.has(String(t?.name || '').trim().toLowerCase()));
      monthlyDiaryEntries.push({
        id: entry._id,
        date: dayjs(entry.date).format('YYYY-MM-DD'),
        item: entry.item || '',
        event: entry.event || '',
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
      if (!entry.menu) return;
      const menu = entry.menu;
      const groupId = entry.group?._id?.toString() || 'unknown';
      const groupName = entry.group?.group_name || 'グループ未設定';
      if (!mealGroupsMap.has(groupId)) {
        mealGroupsMap.set(groupId, {
          groupId,
          groupName,
          meals: { breakfast: [], lunch: [], dinner: [] },
          dinnerComment: ''
        });
      }
      const setMenus = Array.isArray(menu.setMenus) ? menu.setMenus : [];
      const setImages = menu.menuType === 'set'
        ? setMenus
          .filter(item => item && item.imageUrl)
          .map(item => ({ url: item.imageUrl, name: item.name || '' }))
          .slice(0, 5)
        : [];
      const mealEntry = {
        id: entry._id,
        mealType: entry.mealType,
        mealLabel: mealLabelMap[entry.mealType] || entry.mealType,
        name: menu.name || '',
        junle: menu.junle || '',
        kind: menu.kind || '',
        imageUrl: menu.imageUrl || '',
        menuType: menu.menuType || 'single',
        setImages
      };
      const bucket = mealGroupsMap.get(groupId).meals[entry.mealType];
      if (bucket) bucket.push(mealEntry);
    });

    mealGroupsMap.forEach((group, id) => {
      const commentData = mealCommentMap.get(id);
      group.dinnerComment = commentData?.comment || '';
    });

    if (groupId && !mealGroupsMap.has(String(groupId))) {
      const activeComment = mealCommentMap.get(String(groupId));
      if (activeComment) {
        const activeGroup = await Group.findById(groupId).select('group_name');
        mealGroupsMap.set(String(groupId), {
          groupId: String(groupId),
          groupName: activeGroup?.group_name || 'グループ未設定',
          meals: { breakfast: [], lunch: [], dinner: [] },
          dinnerComment: activeComment.comment || ''
        });
      }
    }

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

router.post('/eventcal2/meal-comment', isLoggedIn, async (req, res) => {
  try {
    const { groupId, date, comment } = req.body || {};
    if (!groupId || !date) {
      return res.status(400).json({ message: 'groupIdとdateは必須です' });
    }

    const targetDate = new Date(date);
    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ message: '日付の形式が不正です' });
    }
    targetDate.setHours(0, 0, 0, 0);

    const plan = await WeeklyMenuPlan.findOne({
      group: groupId,
      weekStart: { $lte: targetDate },
      weekEnd: { $gte: targetDate }
    }).sort({ weekStart: -1 });

    if (!plan) {
      return res.status(404).json({ message: '該当する週間献立が見つかりません' });
    }

    const dayComment = (plan.dayComments || []).find(dc => (
      dayjs(dc.date).format('YYYY-MM-DD') === dayjs(targetDate).format('YYYY-MM-DD')
    ));

    if (dayComment) {
      dayComment.comment = String(comment || '').trim();
      await plan.save();
      return res.json({ comment: dayComment.comment || '' });
    }

    const weekStart = new Date(plan.weekStart);
    weekStart.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((targetDate.getTime() - weekStart.getTime()) / 86400000);
    if (diffDays < 0 || diffDays > 6) {
      return res.status(400).json({ message: '日付が週間献立の範囲外です' });
    }

    plan.dayComments = Array.isArray(plan.dayComments) ? plan.dayComments : [];
    const newComment = {
      dayIndex: diffDays,
      date: targetDate,
      comment: String(comment || '').trim()
    };
    plan.dayComments.push(newComment);
    await plan.save();

    return res.json({ comment: newComment.comment || '' });
  } catch (error) {
    console.error('食事コメント更新エラー:', error);
    return res.status(500).json({ message: 'コメントの更新に失敗しました' });
  }
});

module.exports = router;
