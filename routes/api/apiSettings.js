// routes/api/apiSettings.js
const express = require('express');
const router = express.Router();
const FinanceUser = require('../../models/users');
const Group = require('../../models/groups');
const FinanceBudgetNoticeSetting = require('../../models/finance_budget_notice_setting');
const MatometeSetting = require('../../models/matomete_setting');
const PaymentItem = require('../../models/paymentItems');
const multer = require('multer');
const { getStorage } = require('../../cloudinary');
const {
  FINANCE_QUICK_MENU_ITEMS,
  normalizeQuickMenuItems,
  buildQuickMenuItems
} = require('../../Utils/financeQuickMenu');

// 共通ログ
router.use((req, res, next) => {
  next();
});

// 認証チェック（セッション前提）
function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

router.use(requireLogin);

const upload = multer({ storage: getStorage() });

// GET /api/settings/profile
router.get('/profile', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id)
      .select('username displayname email birth_date entry_date update_date avatar blood rh sex isAdmin groups unsubscribe_date')
      .populate({
        path: 'groups',
        select: 'group_name createdBy invitedUsers'
      })
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const email = user.email || '';
    const groups = (user.groups || []).map(g => {
      const isCreator = String(g.createdBy) === String(user._id);
      const isAdmin = isCreator || (g.invitedUsers || []).includes(email);
      return {
        id: String(g._id),
        name: g.group_name || '',
        role: isAdmin ? '管理者' : 'ユーザー'
      };
    });

    res.json({
      user: {
        id: String(user._id),
        username: user.username,
        displayname: user.displayname || '',
        email: user.email || '',
        birth_date: user.birth_date || null,
        entry_date: user.entry_date || null,
        update_date: user.update_date || null,
        avatar: user.avatar || null,
        blood: user.blood || '',
        rh: user.rh || '',
        sex: user.sex || '',
        isAdmin: Boolean(user.isAdmin),
        unsubscribe_date: user.unsubscribe_date || null
      },
      groups
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/profile
router.put('/profile', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const {
      displayname,
      email,
      birth_date,
      blood,
      rh,
      sex
    } = req.body || {};

    if (typeof displayname === 'string') user.displayname = displayname;
    if (typeof email === 'string') user.email = email;
    if (typeof blood === 'string') user.blood = blood;
    if (typeof rh === 'string') user.rh = rh;
    if (typeof sex === 'string') user.sex = sex;

    if (birth_date === null || birth_date === '') {
      user.birth_date = null;
    } else if (birth_date) {
      const parsed = new Date(birth_date);
      if (!isNaN(parsed.getTime())) {
        user.birth_date = parsed;
      }
    }

    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/profile/avatar
router.post('/profile/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    if (req.file) {
      user.avatar = req.file.path;
      user.update_date = new Date();
      await user.save();
    }

    res.json({ ok: true, avatar: user.avatar || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/password
router.post('/password', async (req, res, next) => {
  try {
    const { newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'missing_params', message: 'newPassword, confirmPassword は必須です' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'mismatch', message: 'パスワードが一致しません' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'too_short', message: 'パスワードは8文字以上で入力してください' });
    }

    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    await new Promise((resolve, reject) => {
      user.setPassword(newPassword, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/unsubscribe
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    user.unsubscribe_date = new Date();
    if (user.services && typeof user.services === 'object') {
      user.services.finance = false;
    }
    user.update_date = new Date();
    await user.save();

    req.logout(() => {
      req.session?.destroy(() => {
        res.json({ ok: true });
      });
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/fiscal?group=GROUP_ID
router.get('/fiscal', async (req, res, next) => {
  try {
    const groupId = String(req.query.group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const group = await Group.findById(groupId).lean();
    if (!group) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }
    res.json({
      financeFiscalStartMonth: group.financeFiscalStartMonth || 1,
      financeWalletManagementEnabled: Boolean(group.financeWalletManagementEnabled)
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/fiscal
router.put('/fiscal', async (req, res, next) => {
  try {
    const { group, financeFiscalStartMonth, financeWalletManagementEnabled } = req.body || {};
    const groupId = String(group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const monthNum = Number(financeFiscalStartMonth);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'invalid_month', message: '1〜12の月を指定してください' });
    }
    const groupDoc = await Group.findById(groupId);
    if (!groupDoc) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }
    groupDoc.financeFiscalStartMonth = monthNum;
    if (typeof financeWalletManagementEnabled === 'boolean') {
      groupDoc.financeWalletManagementEnabled = financeWalletManagementEnabled;
    }
    await groupDoc.save();
    res.json({
      ok: true,
      financeFiscalStartMonth: monthNum,
      financeWalletManagementEnabled: Boolean(groupDoc.financeWalletManagementEnabled)
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/budget-notice?group=GROUP_ID
router.get('/budget-notice', async (req, res, next) => {
  try {
    const groupId = String(req.query.group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const group = await Group.findById(groupId).lean();
    if (!group) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const user = await FinanceUser.findById(req.user._id)
      .select('financeBudgetNoticeEnabled financeBudgetNoticeThresholds')
      .lean();
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const notice = await FinanceBudgetNoticeSetting.findOne({ group: groupId }).lean();
    res.json({
      enabled: user.financeBudgetNoticeEnabled !== false,
      thresholds: Array.isArray(user.financeBudgetNoticeThresholds) && user.financeBudgetNoticeThresholds.length > 0
        ? user.financeBudgetNoticeThresholds
        : [50, 80, 90],
      noticeHour: Number.isInteger(notice?.noticeHour) ? notice.noticeHour : 8
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/budget-notice
router.put('/budget-notice', async (req, res, next) => {
  try {
    const { group, enabled, thresholds, noticeHour } = req.body || {};
    const groupId = String(group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const groupDoc = await Group.findById(groupId).lean();
    if (!groupDoc) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    if (typeof enabled === 'boolean') {
      user.financeBudgetNoticeEnabled = enabled;
    }

    if (Array.isArray(thresholds) && thresholds.length > 0) {
      const clean = thresholds
        .map(v => Number(v))
        .filter(v => Number.isFinite(v))
        .map(v => Math.max(0, Math.min(100, Math.round(v))));
      if (clean.length > 0) {
        user.financeBudgetNoticeThresholds = clean.slice(0, 3);
      }
    }

    await user.save();

    const hourNum = Number(noticeHour);
    if (!Number.isInteger(hourNum) || hourNum < 0 || hourNum > 23) {
      return res.status(400).json({ error: 'invalid_hour', message: '0〜23の時刻を指定してください' });
    }

    await FinanceBudgetNoticeSetting.findOneAndUpdate(
      { group: groupId },
      { $set: { noticeHour: hourNum } },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/matomete?group=GROUP_ID
router.get('/matomete', async (req, res, next) => {
  try {
    const groupId = String(req.query.group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const group = await Group.findById(groupId).lean();
    if (!group) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const setting = await MatometeSetting.findOne({ group: groupId }).lean();
    const user = await FinanceUser.findById(req.user._id)
      .select('matometeReminderEnabled')
      .lean();
    res.json({
      reminderEnabled: user?.matometeReminderEnabled !== false,
      reminderDays: Number.isInteger(setting?.reminderDays) ? setting.reminderDays : 7,
      reminderHour: Number.isInteger(setting?.reminderHour) ? setting.reminderHour : 8
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/matomete
router.put('/matomete', async (req, res, next) => {
  try {
    const { group, reminderDays, reminderHour, reminderEnabled } = req.body || {};
    const groupId = String(group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const groupDoc = await Group.findById(groupId).lean();
    if (!groupDoc) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    if (typeof reminderEnabled === 'boolean') {
      const user = await FinanceUser.findById(req.user._id);
      if (!user) {
        return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
      }
      user.matometeReminderEnabled = reminderEnabled;
      await user.save();
    }

    const daysNum = Number(reminderDays);
    const hourNum = Number(reminderHour);
    if (!Number.isInteger(daysNum) || daysNum < 0) {
      return res.status(400).json({ error: 'invalid_days', message: '日数は0以上の数値を指定してください' });
    }
    if (!Number.isInteger(hourNum) || hourNum < 0 || hourNum > 23) {
      return res.status(400).json({ error: 'invalid_hour', message: '0〜23の時刻を指定してください' });
    }

    await MatometeSetting.findOneAndUpdate(
      { group: groupId },
      { $set: { reminderDays: daysNum, reminderHour: hourNum } },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/payment-items?group=GROUP_ID
router.get('/payment-items', async (req, res, next) => {
  try {
    const groupId = String(req.query.group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const group = await Group.findById(groupId).lean();
    if (!group) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(group.members) ? group.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const items = await PaymentItem.find({ group: groupId, user: req.user._id })
      .sort({ display_order: 1, paymentItem: 1 })
      .lean();

    res.json(items.map(it => ({
      id: String(it._id),
      paymentItem: String(it.paymentItem || ''),
      display_order: Number(it.display_order ?? 0),
      isLive: Boolean(it.isLive)
    })));
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/payment-items
router.put('/payment-items', async (req, res, next) => {
  try {
    const { group, items } = req.body || {};
    const groupId = String(group || '').trim();
    if (!groupId) {
      return res.status(400).json({ error: 'missing_params', message: 'group は必須です' });
    }
    const groupDoc = await Group.findById(groupId).lean();
    if (!groupDoc) {
      return res.status(404).json({ error: 'not_found', message: 'グループが見つかりません' });
    }
    const memberIds = Array.isArray(groupDoc.members) ? groupDoc.members.map(String) : [];
    if (!memberIds.includes(String(req.user._id))) {
      return res.status(403).json({ error: 'forbidden', message: 'グループ権限がありません' });
    }

    const list = Array.isArray(items) ? items : [];
    await PaymentItem.deleteMany({ group: groupId, user: req.user._id });

    const docs = list.map((it, index) => ({
      paymentItem: String(it.paymentItem ?? ''),
      display_order: Number(it.display_order ?? (index + 1)),
      isLive: Boolean(it.isLive),
      user: req.user._id,
      group: groupId
    })).filter(d => d.paymentItem);

    if (docs.length > 0) {
      await PaymentItem.insertMany(docs);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/finance-quick-menu
router.get('/finance-quick-menu', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id)
      .select('financeQuickMenuItems')
      .lean();
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    res.json({
      options: FINANCE_QUICK_MENU_ITEMS,
      items: buildQuickMenuItems(user.financeQuickMenuItems)
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/finance-quick-menu
router.put('/finance-quick-menu', async (req, res, next) => {
  try {
    const cleaned = normalizeQuickMenuItems(req.body?.items);
    await FinanceUser.findByIdAndUpdate(req.user._id, {
      financeQuickMenuItems: cleaned
    });
    res.json({ ok: true, items: buildQuickMenuItems(cleaned) });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/inactivity-reminder
router.get('/inactivity-reminder', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id)
      .select('inactivityReminderDays')
      .lean();
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }
    res.json({
      inactivityReminderDays: Number.isInteger(user.inactivityReminderDays) ? user.inactivityReminderDays : 3
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/inactivity-reminder
router.put('/inactivity-reminder', async (req, res, next) => {
  try {
    const { inactivityReminderDays } = req.body || {};
    const daysNum = Number(inactivityReminderDays);
    if (!Number.isInteger(daysNum) || daysNum < 1 || daysNum > 31) {
      return res.status(400).json({ error: 'invalid_days', message: '1〜31の日数を指定してください' });
    }
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }
    user.inactivityReminderDays = daysNum;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
