const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { isLoggedIn, logAction } = require('../middleware');
const FinanceUser = require('../models/users');
const MessageItem = require('../models/messageItem');
const MessageSetting = require('../models/messageSetting');
const MessageStatus = require('../models/messageStatus');
const MessageAccessToken = require('../models/messageAccessToken');
const MessageAliveToken = require('../models/messageAliveToken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cron = require('node-cron');
const { sendMail } = require('../Utils/mailer');

const messageCategories = [
  '銀行口座',
  '証券口座',
  '保険',
  '携帯電話',
  'ネットサービス',
  'ライフライン',
  'メール/アカウント',
  'その他'
];

const resolveActiveGroup = (req) => {
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    return null;
  }
  return typeof activeGroupId === 'string'
    ? new mongoose.Types.ObjectId(activeGroupId)
    : activeGroupId;
};

const daysBetween = (from, to) => {
  const start = new Date(from);
  const end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
};

const buildBaseUrl = () => (
  process.env.NODE_ENV === 'production' && process.env.BASE_URL
    ? process.env.BASE_URL
    : 'http://localhost:3000'
);

const ensureAliveStatus = async ({ userId, groupId, source }) => {
  const now = new Date();
  const status = await MessageStatus.findOneAndUpdate(
    { user: userId, group: groupId },
    {
      last_alive_at: now,
      last_alive_source: source,
      warning_started_at: null,
      warning_days_sent: 0,
      pre_notice_sent_at: null,
      final_sent_at: null
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return status;
};

router.get('/', isLoggedIn, (req, res) => {
  res.redirect('/message/top');
});

router.get('/top', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    const q = (req.query.q || '').trim();
    const category = (req.query.category || '').trim();
    const statusFilterValue = (req.query.status || '').trim();
    const searchFilter = q
      ? { $or: [{ title: { $regex: q, $options: 'i' } }, { category: { $regex: q, $options: 'i' } }] }
      : {};
    const categoryFilter = category ? { category } : {};
    const statusFilter = statusFilterValue === 'on' ? { is_active: true } : statusFilterValue === 'off' ? { is_active: false } : {};

    const baseFilter = { group: activeGroupId };
    const sharedFilter = {
      share_scope: { $in: ['all', 'selected'] },
      $or: [
        { share_scope: 'all' },
        { share_scope: 'selected', shared_members: req.user._id }
      ]
    };

    const items = await MessageItem.find({
      ...baseFilter,
      ...categoryFilter,
      ...statusFilter,
      $and: [searchFilter],
      $or: [
        { user: req.user._id },
        sharedFilter
      ]
    })
      .populate('user', 'displayname username')
      .sort({ update_date: -1 });

    const group = await FinanceUser.findById(req.user._id).populate('groups');
    const groupMembers = group?.groups?.length
      ? await FinanceUser.find({ _id: { $in: group.groups[0].members } }).sort({ displayname: 1 })
      : [];

    const viewItems = items.map((item) => {
      const isOwner = String(item.user?._id || item.user) === String(req.user._id);
      return {
        ...item.toObject(),
        isOwner,
        decryptedContent: isOwner ? item.decryptContent() : ''
      };
    });

    const status = await MessageStatus.findOne({ user: req.user._id, group: activeGroupId });
    const aliveStatus = status?.last_alive_source === 'email'
      ? 'メールで確認済み'
      : status?.last_alive_source === 'service'
        ? 'サービス利用で確認済み'
        : '未確認';

    res.render('message/top', {
      items: viewItems,
      messageCategories,
      groupMembers,
      searchQuery: q,
      selectedCategory: category,
      selectedStatus: statusFilterValue,
      aliveStatus,
      aliveAt: status?.last_alive_at || null,
      isTestEnv: process.env.NODE_ENV !== 'production'
    });
  } catch (error) {
    console.error('Message 一覧取得エラー:', error);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

router.get('/settings', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    const setting = await MessageSetting.findOne({
      user: req.user._id,
      group: activeGroupId
    });

    const group = await FinanceUser.findById(req.user._id).populate('groups');
    const groupMembers = group?.groups?.length
      ? await FinanceUser.find({ _id: { $in: group.groups[0].members } }).sort({ displayname: 1 })
      : [];

    res.render('message/settings', { setting, groupMembers });
  } catch (error) {
    console.error('Message 設定取得エラー:', error);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

router.post('/alive/confirm-now', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    await ensureAliveStatus({ userId: req.user._id, groupId: activeGroupId, source: 'service' });
    req.flash('success', 'Alive確認を更新しました');
    res.redirect('/message/top');
  } catch (error) {
    console.error('Alive手動更新エラー:', error);
    req.flash('error', 'Alive更新に失敗しました');
    res.redirect('/message/top');
  }
});

router.get('/alive/confirm/:token', async (req, res) => {
  try {
    const tokenDoc = await MessageAliveToken.findOne({ token: req.params.token });
    if (!tokenDoc || tokenDoc.expires_at < new Date()) {
      return res.status(404).render('error', { err: { message: '確認リンクの有効期限が切れています。' }, showStack: false });
    }

    const setting = await MessageSetting.findOne({ user: tokenDoc.user, group: tokenDoc.group }).populate('user');
    if (!setting) {
      return res.status(404).render('error', { err: { message: 'Message設定が見つかりません。' }, showStack: false });
    }

    const status = await ensureAliveStatus({ userId: tokenDoc.user, groupId: tokenDoc.group, source: 'email' });
    tokenDoc.used_at = new Date();
    await tokenDoc.save();

    if (setting.user && setting.user.email && setting.user.isMail !== false) {
      try {
        await sendMail({
          to: setting.user.email,
          subject: '【All About me】Alive！確認 完了',
          templateName: 'messageAliveConfirmed',
          templateData: {
            name: setting.user.displayname || setting.user.username
          }
        });
        status.last_alive_notice_sent_at = new Date();
        await status.save();
      } catch (err) {
        console.error('Alive確認完了メール送信エラー:', err);
      }
    }

    res.render('message/alive_confirmed');
  } catch (error) {
    console.error('Alive確認処理エラー:', error);
    res.status(500).render('error', { err: { message: 'サーバーエラーが発生しました' }, showStack: false });
  }
});

router.post('/alive/test', isLoggedIn, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).send('Not found');
    }
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    const setting = await MessageSetting.findOne({ user: req.user._id, group: activeGroupId });
    if (!setting) {
      req.flash('error', 'Message設定がありません');
      return res.redirect('/message/top');
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await MessageAliveToken.create({
      user: req.user._id,
      group: activeGroupId,
      token,
      expires_at: expiresAt
    });

    const recipients = (setting.confirm_targets && setting.confirm_targets.length)
      ? setting.confirm_targets
          .filter((target) => target.method === 'email')
          .map((target) => target.destination)
          .filter(Boolean)
      : (setting.confirm_emails || []);

    if (recipients.length === 0) {
      req.flash('error', 'メール送付先が設定されていません');
      return res.redirect('/message/top');
    }

    const baseUrl = buildBaseUrl();
    const status = await MessageStatus.findOne({ user: req.user._id, group: activeGroupId });
    const lastAlive = status?.last_alive_at || setting.entry_date || req.user.entry_date || new Date();
    const daysSinceAlive = daysBetween(lastAlive, new Date());
    const confirmDays = Number(setting.confirm_period_days || 30);
    const url = `${baseUrl}/message/alive/confirm/${token}`;

    await sendMail({
      to: recipients.join(','),
      subject: '【All About me】毎日送信　Alive！の確認',
      templateName: 'messageAliveCheck',
      templateData: {
        name: req.user.displayname || req.user.username,
        daysSinceAlive,
        confirmDays,
        url
      }
    });

    req.flash('success', 'テスト用のAlive確認メールを送信しました');
    res.redirect('/message/top');
  } catch (error) {
    console.error('Aliveテストメール送信エラー:', error);
    req.flash('error', 'テスト送信に失敗しました');
    res.redirect('/message/top');
  }
});

router.get('/public/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const tokenDoc = await MessageAccessToken.findOne({ token });
    if (!tokenDoc || tokenDoc.expires_at < new Date()) {
      return res.status(404).render('error', { err: { message: 'アクセス期限が切れています。' }, showStack: false });
    }

    res.render('message/public', { token });
  } catch (error) {
    console.error('公開アクセス初期表示エラー:', error);
    res.status(500).render('error', { err: { message: 'サーバーエラーが発生しました' }, showStack: false });
  }
});

router.post('/public/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const password = (req.body.view_password || '').trim();
    if (!password) {
      req.flash('error', 'パスワードを入力してください');
      return res.redirect(`/message/public/${token}`);
    }

    const tokenDoc = await MessageAccessToken.findOne({ token });
    if (!tokenDoc || tokenDoc.expires_at < new Date()) {
      return res.status(404).render('error', { err: { message: 'アクセス期限が切れています。' }, showStack: false });
    }

    const setting = await MessageSetting.findOne({ user: tokenDoc.user, group: tokenDoc.group });
    if (!setting || !setting.view_password) {
      return res.status(403).render('error', { err: { message: '閲覧パスワードが設定されていません。' }, showStack: false });
    }

    let isMatch = false;
    if (setting.view_password.startsWith('$2')) {
      isMatch = await bcrypt.compare(password, setting.view_password);
    } else {
      const decrypted = setting.decryptViewPassword();
      isMatch = decrypted && decrypted === password;
    }
    if (!isMatch) {
      req.flash('error', 'パスワードが違います');
      return res.redirect(`/message/public/${token}`);
    }

    const items = await MessageItem.find({
      user: tokenDoc.user,
      group: tokenDoc.group,
      is_active: true
    }).sort({ update_date: -1 });

    const viewItems = items.map((item) => ({
      ...item.toObject(),
      decryptedContent: item.decryptContent()
    }));

    tokenDoc.used_at = new Date();
    await tokenDoc.save();

    res.render('message/public_view', { items: viewItems });
  } catch (error) {
    console.error('公開アクセス認証エラー:', error);
    res.status(500).render('error', { err: { message: 'サーバーエラーが発生しました' }, showStack: false });
  }
});

router.post('/settings', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    const update = {
      service_enabled: req.body.service_enabled === 'on',
      confirm_period_days: Number(req.body.confirm_period_days) || 30,
      final_notice_days: Number(req.body.final_notice_days) || 7,
      confirm_methods: [],
      confirm_emails: [],
      confirm_line_id: '',
      confirm_targets: [],
      share_scope: req.body.share_scope || 'private',
      shared_members: [],
      message_body: req.body.message_body || ''
    };

    const methods = req.body.confirm_method;
    const destinations = req.body.confirm_destination;
    const methodList = Array.isArray(methods) ? methods : (methods ? [methods] : []);
    const destinationList = Array.isArray(destinations) ? destinations : (destinations ? [destinations] : []);

    update.confirm_targets = methodList
      .map((method, index) => ({
        method,
        destination: (destinationList[index] || '').trim()
      }))
      .filter((target) => target.method && target.destination);

    update.confirm_methods = update.confirm_targets.map((target) => target.method);
    update.confirm_emails = update.confirm_targets
      .filter((target) => target.method === 'email')
      .map((target) => target.destination);
    const lineTarget = update.confirm_targets.find((target) => target.method === 'line');
    if (lineTarget) {
      update.confirm_line_id = lineTarget.destination;
    }

    if (req.body.view_password && req.body.view_password.trim()) {
      update.view_password = req.body.view_password.trim();
    }

    await MessageSetting.findOneAndUpdate(
      { user: req.user._id, group: activeGroupId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await logAction({ req, action: '更新', target: 'message-setting' });
    req.flash('success', 'Message設定を更新しました');
    res.redirect('/message/settings');
  } catch (error) {
    console.error('Message 設定更新エラー:', error);
    req.flash('error', '設定更新に失敗しました');
    res.redirect('/message/settings');
  }
});

router.post('/', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = resolveActiveGroup(req);
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/setting');
    }

    const setting = await MessageSetting.findOne({ user: req.user._id, group: activeGroupId });
    const shareScope = setting?.share_scope || 'private';
    const sharedMembers = shareScope === 'selected'
      ? (setting?.shared_members || [])
      : [];

    const newItem = new MessageItem({
      category: req.body.category,
      title: req.body.title,
      content: req.body.content,
      url: req.body.url,
      share_scope: shareScope,
      shared_members: sharedMembers,
      is_active: req.body.is_active === 'on',
      start_date: req.body.start_date || null,
      end_date: req.body.end_date || null,
      user: req.user._id,
      group: activeGroupId
    });

    await newItem.save();
    await logAction({ req, action: '登録', target: 'message-item' });
    req.flash('success', 'メッセージを登録しました');
    res.redirect('/message/top');
  } catch (error) {
    console.error('Message 登録エラー:', error);
    req.flash('error', 'メッセージ登録に失敗しました');
    res.redirect('/message/top');
  }
});

router.post('/:id/edit', isLoggedIn, async (req, res) => {
  try {
    const setting = await MessageSetting.findOne({ user: req.user._id, group: req.session.activeGroupId });
    const shareScope = setting?.share_scope || 'private';
    const sharedMembers = shareScope === 'selected'
      ? (setting?.shared_members || [])
      : [];

    const update = {
      category: req.body.category,
      title: req.body.title,
      content: req.body.content,
      url: req.body.url,
      share_scope: shareScope,
      shared_members: sharedMembers,
      is_active: req.body.is_active === 'on',
      start_date: req.body.start_date || null,
      end_date: req.body.end_date || null
    };

    await MessageItem.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      update
    );

    await logAction({ req, action: '編集', target: 'message-item' });
    req.flash('success', 'メッセージを更新しました');
    res.redirect('/message/top');
  } catch (error) {
    console.error('Message 更新エラー:', error);
    req.flash('error', 'メッセージ更新に失敗しました');
    res.redirect('/message/top');
  }
});

router.post('/:id/delete', isLoggedIn, async (req, res) => {
  try {
    await MessageItem.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    await logAction({ req, action: '削除', target: 'message-item' });
    req.flash('success', 'メッセージを削除しました');
    res.redirect('/message/top');
  } catch (error) {
    console.error('Message 削除エラー:', error);
    req.flash('error', 'メッセージ削除に失敗しました');
    res.redirect('/message/top');
  }
});

// Alive確認と通知ワークフロー（毎朝8時）
cron.schedule('0 8 * * *', async () => {
  try {
    const settings = await MessageSetting.find({ service_enabled: true }).populate('user');
    const baseUrl = buildBaseUrl();
    const today = new Date();

    for (const setting of settings) {
      if (!setting.user) continue;
      const status = await MessageStatus.findOneAndUpdate(
        { user: setting.user._id, group: setting.group },
        {},
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const lastAlive = status.last_alive_at || setting.entry_date || setting.user.entry_date || today;
      const daysSinceAlive = daysBetween(lastAlive, today);
      const confirmDays = Number(setting.confirm_period_days || 30);

      if (daysSinceAlive < confirmDays) {
        continue;
      }

      if (!status.pre_notice_sent_at) {
        const recipients = (setting.confirm_targets && setting.confirm_targets.length)
          ? setting.confirm_targets
              .filter((target) => target.method === 'email')
              .map((target) => target.destination)
              .filter(Boolean)
          : (setting.confirm_emails || []);

        if (recipients.length > 0) {
          try {
            await sendMail({
              to: recipients.join(','),
              subject: '【All About me】Message 予告のお知らせ',
              templateName: 'messagePreNotice',
              templateData: {
                name: setting.user.displayname || setting.user.username,
                confirmDays
              }
            });
          } catch (err) {
            console.error('Message 予告メール送信エラー:', err);
          }
        }

        status.pre_notice_sent_at = new Date();
        await status.save();
      }

      const warningDaysLimit = Number(setting.final_notice_days || 7);
      if (!status.warning_started_at) {
        status.warning_started_at = new Date();
        status.warning_days_sent = 0;
        await status.save();
      }

      if (status.warning_days_sent < warningDaysLimit) {
        if (setting.user.isMail !== false && setting.user.email) {
          const token = crypto.randomBytes(24).toString('hex');
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);
          await MessageAliveToken.create({
            user: setting.user._id,
            group: setting.group,
            token,
            expires_at: expiresAt
          });
          const aliveUrl = `${baseUrl}/message/alive/confirm/${token}`;
          try {
            await sendMail({
              to: setting.user.email,
              subject: '⚠️【All About me】未確認の日数が設定した期間を過ぎました。',
              templateName: 'messageWarning',
              templateData: {
                name: setting.user.displayname || setting.user.username,
                daysLeft: warningDaysLimit - status.warning_days_sent,
                url: aliveUrl
              }
            });
          } catch (err) {
            console.error('Message 警告メール送信エラー:', err);
          }
        }
        status.warning_days_sent += 1;
        await status.save();
      }

      if (status.warning_days_sent >= warningDaysLimit && !status.final_sent_at) {
        const recipients = (setting.confirm_targets && setting.confirm_targets.length)
          ? setting.confirm_targets
              .filter((target) => target.method === 'email')
              .map((target) => target.destination)
              .filter(Boolean)
          : (setting.confirm_emails || []);

        if (recipients.length > 0) {
          const token = crypto.randomBytes(24).toString('hex');
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);

          await MessageAccessToken.create({
            user: setting.user._id,
            group: setting.group,
            token,
            expires_at: expiresAt
          });

          const url = `${baseUrl}/message/public/${token}`;
          try {
            await sendMail({
              to: recipients.join(','),
              subject: `⚠️${setting.user.displayname || setting.user.username}さんからMessageをお預かりしています`,
              templateName: 'messageFinal',
              templateData: {
                name: setting.user.displayname || setting.user.username,
                url
              }
            });
          } catch (err) {
            console.error('Message 最終メール送信エラー:', err);
          }

          if (setting.view_password) {
            try {
              const viewPassword = setting.decryptViewPassword();
              if (!viewPassword) {
                throw new Error('パスワード復号に失敗しました');
              }
                await sendMail({
                  to: recipients.join(','),
                  subject: `⚠️${setting.user.displayname || setting.user.username}さんからMessageをお預かりしています`,
                  templateName: 'messageFinalPassword',
                  templateData: {
                    name: setting.user.displayname || setting.user.username,
                    password: viewPassword
                  }
                });
            } catch (err) {
              console.error('Message パスワード送信エラー:', err);
            }
          }
        }

        status.final_sent_at = new Date();
        await status.save();
      }
    }
  } catch (error) {
    console.error('Message Alive cron error:', error);
  }
});

// Alive確認メール送信（毎朝10時）
cron.schedule('0 10 * * *', async () => {
  try {
    const settings = await MessageSetting.find({ service_enabled: true }).populate('user');
    const baseUrl = buildBaseUrl();
    const today = new Date();

    for (const setting of settings) {
      if (!setting.user) continue;

      const recipients = (setting.confirm_targets && setting.confirm_targets.length)
        ? setting.confirm_targets
            .filter((target) => target.method === 'email')
            .map((target) => target.destination)
            .filter(Boolean)
        : (setting.confirm_emails || []);

      if (recipients.length === 0) continue;

      const status = await MessageStatus.findOneAndUpdate(
        { user: setting.user._id, group: setting.group },
        {},
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const lastAlive = status.last_alive_at || setting.entry_date || setting.user.entry_date || today;
      const daysSinceAlive = daysBetween(lastAlive, today);
      const confirmDays = Number(setting.confirm_period_days || 30);

      const token = crypto.randomBytes(24).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await MessageAliveToken.create({
        user: setting.user._id,
        group: setting.group,
        token,
        expires_at: expiresAt
      });

      const url = `${baseUrl}/message/alive/confirm/${token}`;

      try {
        await sendMail({
          to: recipients.join(','),
          subject: '【All About me】毎日送信　Alive！の確認',
          templateName: 'messageAliveCheck',
          templateData: {
            name: setting.user.displayname || setting.user.username,
            daysSinceAlive,
            confirmDays,
            url
          }
        });
      } catch (err) {
        console.error('Alive確認メール送信エラー:', err);
      }
    }
  } catch (error) {
    console.error('Alive確認cronエラー:', error);
  }
});

module.exports = router;
