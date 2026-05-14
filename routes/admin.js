require('dotenv').config();
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
// const Finance = require('../models/finance');
const Info = require('../models/info');
const Group = require('../models/groups');
const FinanceUser = require('../models/users');
const Log = require('../models/log');
const Inquiry = require('../models/inquiry');
const Qa = require('../models/qa'); 
const Planner = require('../models/planner');
const MessageSetting = require('../models/messageSetting');
const MessageStatus = require('../models/messageStatus');
const MessageAccessToken = require('../models/messageAccessToken');
const MessageAliveToken = require('../models/messageAliveToken');
const crypto = require('crypto');

const { isAdmin, logAction } = require('../middleware');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const archiver = require('archiver');
const multer = require('multer');
const JSZip = require('jszip');
// const nodemailer = require('nodemailer');
const { sendMail } = require('../Utils/mailer');
const OcrLog = require('../models/ocrs');
const dictentry = require('../models/dictentry'); // 作成したモデル
const dictPath = path.join(__dirname, '../Utils/categoryDictionary.json');

const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isZip = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || path.extname(file.originalname || '').toLowerCase() === '.zip';
    cb(isZip ? null : new Error('ZIPファイルを選択してください'), isZip);
  }
});

const loadBackupModelMap = () => {
  const modelsPath = path.join(__dirname, '../models');
  const modelMap = new Map();

  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      if (!entry.name.endsWith('.js') || entry.name === 'index.js') return;

      const modelName = path.basename(entry.name, '.js');
      try {
        const model = require(fullPath);
        if (typeof model.find === 'function' && typeof model.deleteMany === 'function' && typeof model.insertMany === 'function') {
          modelMap.set(modelName, model);
        }
      } catch (e) {
        console.warn(`[admin restore] モデル ${modelName} の読み込みに失敗:`, e.message);
      }
    });
  };

  walk(modelsPath);
  return modelMap;
};

const parseBackupZip = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const modelMap = loadBackupModelMap();
  const entries = [];

  for (const [zipName, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir || path.extname(zipName).toLowerCase() !== '.json') continue;

    const baseName = path.basename(zipName, '.json');
    const model = modelMap.get(baseName);
    const raw = await zipEntry.async('string');
    let docs;

    try {
      docs = JSON.parse(raw);
    } catch (e) {
      entries.push({ fileName: zipName, modelName: baseName, count: 0, status: 'invalid_json' });
      continue;
    }

    if (!Array.isArray(docs)) {
      entries.push({ fileName: zipName, modelName: baseName, count: 0, status: 'not_array' });
      continue;
    }

    entries.push({
      fileName: zipName,
      modelName: baseName,
      count: docs.length,
      status: model ? 'ready' : 'unknown_model'
    });
  }

  return entries.sort((a, b) => a.modelName.localeCompare(b.modelName));
};

const saveRestoreUpload = (buffer) => {
  const restoreDir = path.join(__dirname, '../tmp/restore');
  fs.mkdirSync(restoreDir, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const zipPath = path.join(restoreDir, `${token}.zip`);
  fs.writeFileSync(zipPath, buffer);
  return { token, zipPath };
};

const ex_cfs = [
  '副食物費','主食費1','主食費2','調味料','光熱費','住宅・家具費',
  '衣服費','教育費','交際費','教養費','娯楽費','保険・衛生費',
  '職業費','特別費','公共費','車関連費','通信費','外税'
];

//管理画面トップの表示（管理者のみ）
router.get('/', isAdmin, (req,res) => {
    res.render('admin/top')
});

// お知らせの一覧表示
router.get('/info', isAdmin, async (req, res) => {
  const infos = await Info.find().populate('target_group').sort({ from_date: -1 });
  res.render('admin/info', { infos });
});

// 新規お知らせ作成画面表示
router.get('/info/new', isAdmin, async (req, res) => {
  const groups = await Group.find({});
  res.render('admin/infoForm', { info: null, groups });
});

// 新規お知らせ登録処理
router.post('/info', isAdmin, async (req, res) => {
  const { info_title, info_content, app_url, guide_url, pub_target, mail_delivery, from_date, end_date } = req.body;
  await Info.create({
    info_title,
    info_content,
    app_url,
    guide_url,
    pub_target,
    mail_delivery: mail_delivery === 'on',
    from_date,
    end_date,
    entry_date: new Date()
  });
    await logAction({ req, action: '登録', target: 'お知らせ' });
  req.flash('success', 'お知らせを登録しました');
  res.redirect('/admin/info');
});

// お知らせ編集画面の表示
router.get('/info/:id/edit', isAdmin, async (req, res) => {
  const info = await Info.findById(req.params.id);
  if (!info) {
    req.flash('error', 'お知らせが見つかりません');
    return res.redirect('/admin/info');
  }
  const groups = await Group.find({});
  res.render('admin/infoForm', { info, groups });
});

// 編集したお知らせの更新
// PUT: お知らせの更新
router.put('/info/:id', isAdmin, async (req, res) => {
  try {
    const { info_title, info_content, app_url, guide_url, pub_target, mail_delivery, from_date, end_date } = req.body;

    const updateData = {
      info_title,
      info_content,
      app_url,
      guide_url,
      pub_target,
      mail_delivery: mail_delivery === 'on',
      from_date,
      end_date,
      update_date: new Date()
    };

    // もし pub_target がグループIDだった場合は target_group にも設定
    if (pub_target !== 'all' && mongoose.Types.ObjectId.isValid(pub_target)) {
      updateData.target_group = pub_target;
    } else {
      updateData.target_group = null;
    }

    await Info.findByIdAndUpdate(req.params.id, updateData);
        await logAction({ req, action: '更新', target: 'お知らせ' });
    req.flash('success', 'お知らせを更新しました');
    res.redirect('/admin/info');
  } catch (err) {
    console.error('お知らせ更新エラー:', err);
    req.flash('error', '更新中にエラーが発生しました');
    res.redirect('/admin/info');
  }
});

// お知らせ削除処理
router.post('/info/:id/delete', isAdmin, async (req, res) => {
  await Info.findByIdAndDelete(req.params.id);
    await logAction({ req, action: '削除', target: 'お知らせ' });
  req.flash('success', 'お知らせを削除しました');
  res.redirect('/admin/info');
});

//ユーザー管理機能
// ユーザー一覧表示（検索機能付き）
router.get('/users', isAdmin, async (req, res) => {
  const { q } = req.query;
  const searchQuery = q
    ? {
        $or: [
          { username: new RegExp(q, 'i') },
          { displayname: new RegExp(q, 'i') },
          { email: new RegExp(q, 'i') }
        ]
      }
    : {};

    const users = await FinanceUser.find(searchQuery)
    .populate('groups') // ← 追加
    .sort({ update_date: -1 });
    res.render('admin/users', { users, query: q || '' });
});

// Message 管理一覧
router.get('/message', isAdmin, async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const settings = await MessageSetting.find({}).populate('user');

  const rows = [];
  for (const setting of settings) {
    const userName = setting.user?.displayname || setting.user?.username || '不明';
    const serviceStatus = setting.service_enabled ? 'ON' : 'OFF';
    const confirmDays = Number(setting.confirm_period_days || 30);

    const status = await MessageStatus.findOne({ user: setting.user?._id, group: setting.group });
    const lastAlive = status?.last_alive_at || setting.entry_date || setting.user?.entry_date || new Date();
    const today = new Date();
    const diffDays = Math.floor((new Date(today.toDateString()) - new Date(new Date(lastAlive).toDateString())) / (1000 * 60 * 60 * 24));

    let shareLabel = '非公開';
    let shareMembersLabel = '';
    if (setting.share_scope === 'all') {
      shareLabel = '全員';
      shareMembersLabel = '全員';
    } else if (setting.share_scope === 'selected') {
      shareLabel = '個別';
      const members = await FinanceUser.find({ _id: { $in: setting.shared_members || [] } });
      shareMembersLabel = members.map(m => m.displayname || m.username).join('<br>');
    }

    const shareDisplay = shareMembersLabel ? `${shareLabel}<br>${shareMembersLabel}` : shareLabel;

    rows.push({
      settingId: setting._id,
      userName,
      serviceStatus,
      shareDisplay,
      confirmDays,
      daysSinceAlive: diffDays,
      canWarn: diffDays >= confirmDays,
      canShare: setting.share_scope === 'all' || setting.share_scope === 'selected',
      isTestEnv: process.env.NODE_ENV !== 'production'
    });
  }

  const filtered = q
    ? rows.filter(row => {
        const haystack = [
          row.userName,
          row.serviceStatus,
          row.shareDisplay,
          String(row.confirmDays),
          String(row.daysSinceAlive)
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : rows;

  res.render('admin/message', { rows: filtered, query: req.query.q || '' });
});

// 未確認テスト警告メール送信
router.post('/message/:id/warn-test', isAdmin, async (req, res) => {
  const setting = await MessageSetting.findById(req.params.id).populate('user');
  if (!setting || !setting.user) {
    req.flash('error', '対象が見つかりません');
    return res.redirect('/admin/message');
  }
  if (setting.user.isMail === false || !setting.user.email) {
    req.flash('error', '送信先メールがありません');
    return res.redirect('/admin/message');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await MessageAliveToken.create({
    user: setting.user._id,
    group: setting.group,
    token,
    expires_at: expiresAt
  });
  const baseUrl = process.env.NODE_ENV === 'production' && process.env.BASE_URL
    ? process.env.BASE_URL
    : 'http://localhost:3000';
  const aliveUrl = `${baseUrl}/message/alive/confirm/${token}`;
  const warnDays = Number(setting.final_notice_days || 7);

  await sendMail({
    to: setting.user.email,
    subject: '⚠️【All About me】未確認の日数が設定した期間を過ぎました。',
    templateName: 'messageWarning',
    templateData: {
      name: setting.user.displayname || setting.user.username,
      daysLeft: warnDays,
      url: aliveUrl
    }
  });

  req.flash('success', '警告メールを送信しました');
  res.redirect('/admin/message');
});

// 共有メンバー向けテストメール送信
router.post('/message/:id/share-test', isAdmin, async (req, res) => {
  const setting = await MessageSetting.findById(req.params.id).populate('user');
  if (!setting || !setting.user) {
    req.flash('error', '対象が見つかりません');
    return res.redirect('/admin/message');
  }

  let recipientUsers = [];
  if (setting.share_scope === 'all') {
    const group = await Group.findById(setting.group);
    recipientUsers = group?.members?.length
      ? await FinanceUser.find({ _id: { $in: group.members } })
      : [];
  } else if (setting.share_scope === 'selected') {
    recipientUsers = await FinanceUser.find({ _id: { $in: setting.shared_members || [] } });
  }

  const recipients = recipientUsers
    .map(user => user.email)
    .filter(Boolean);

  if (recipients.length === 0) {
    req.flash('error', '共有メンバーのメールがありません');
    return res.redirect('/admin/message');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await MessageAccessToken.create({
    user: setting.user._id,
    group: setting.group,
    token,
    expires_at: expiresAt
  });

  const baseUrl = process.env.NODE_ENV === 'production' && process.env.BASE_URL
    ? process.env.BASE_URL
    : 'http://localhost:3000';
  const url = `${baseUrl}/message/public/${token}`;

  await sendMail({
    to: recipients.join(','),
    subject: `【⚠️重要⚠️】${setting.user.displayname || setting.user.username}さんからのMessageを預かっています。`,
    templateName: 'messageFinal',
    templateData: {
      name: setting.user.displayname || setting.user.username,
      url
    }
  });

  if (setting.view_password) {
    await sendMail({
      to: recipients.join(','),
      subject: `【⚠️重要⚠️】${setting.user.displayname || setting.user.username}さんからのMessageを預かっています。`,
      templateName: 'messageFinalPassword',
      templateData: {
        name: setting.user.displayname || setting.user.username,
        password: setting.decryptViewPassword()
      }
    });
  }

  req.flash('success', '共有テストメールを送信しました');
  res.redirect('/admin/message');
});

// ユーザー詳細取得（モーダル表示用API）
router.get('/users/:id/json', isAdmin, async (req, res) => {
  try {
    const user = await FinanceUser.findById(req.params.id).populate('groups');
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: '取得中にエラーが発生しました' });
  }
});

// ユーザー更新処理
router.put('/users/:id', isAdmin, async (req, res) => {
  const { displayname, email, memo, tags, isAdmin: adminFlag, isActive, isPlanner } = req.body;
  await FinanceUser.findByIdAndUpdate(req.params.id, {
    displayname,
    email,
    memo,
    tags,
    isAdmin: adminFlag === 'on',
    isActive: isActive === 'on',
    isMail: req.body.isMail === 'on',
    isPlanner: req.body.isPlanner === 'on',
        services: {
          allaboutme: req.body.services_allaboutme === 'true' || req.body.services_allaboutme === 'on',
          finance: req.body.services_finance === 'true' || req.body.services_finance === 'on',
          assets: req.body.services_assets === 'true' || req.body.services_assets === 'on',
          message: req.body.services_message === 'true' || req.body.services_message === 'on'
        },
    update_date: new Date()
  });
  req.flash('success', 'ユーザー情報を更新しました');
  res.redirect('/admin/users');
});

// ユーザー削除処理
router.post('/users/:id/delete', isAdmin, async (req, res) => {
  await FinanceUser.findByIdAndDelete(req.params.id);
  req.flash('success', 'ユーザーを削除しました');
  res.redirect('/admin/users');
});

//アクセスログ
// ログ表示
router.get('/logs', isAdmin, async (req, res) => {

  const loginLogs = await Log.find({ type: 'login' }).sort({ timestamp: -1 }).limit(100);
  const pageLogs = await Log.find({ type: 'page' }).sort({ timestamp: -1 }).limit(100);
  const actionLogs = await Log.find({ type: 'action' }).sort({ timestamp: -1 }).limit(100);

  res.render('admin/log', {
    loginLogs,
    pageLogs,
    actionLogs
  });
});

//　グループ管理
router.get('/groups', isAdmin, async (req, res) => {
  const groups = await Group.find({})
    .populate('members')
    .populate('createdBy')
    .sort({ createdAt: -1 });

  const groupData = groups.map(g => ({
    _id: g._id,
    group_name: g.group_name,
    memberCount: g.members.length,
    createdBy: g.createdBy?.username || '不明',
    createdAt: g.createdAt,
    updatedAt: g.updatedAt
  }));

  res.render('admin/groups', { groups: groupData });
});

// グループ情報編集画面表示
router.get('/groups/:id/edit', isAdmin, async (req, res) => {
  const group = await Group.findById(req.params.id).populate('members').populate('createdBy');
  const users = await FinanceUser.find({});
  if (!group) {
    req.flash('error', 'グループが見つかりません');
    return res.redirect('/admin/groups');
  }
  res.render('admin/groupForm', { group, users });
});

// グループ情報更新処理
router.put('/groups/:id', isAdmin, async (req, res) => {
  const { group_name, createdBy } = req.body;
  await Group.findByIdAndUpdate(req.params.id, {
    group_name,
    createdBy,
    updatedAt: new Date()
  });
  await logAction({ req, action: '更新', target: 'グループ管理' });
  req.flash('success', 'グループ情報を更新しました');
  res.redirect('/admin/groups');
});

// グループ削除処理
router.post('/groups/:id/delete', isAdmin, async (req, res) => {
  await Group.findByIdAndDelete(req.params.id);
  await logAction({ req, action: '削除', target: 'グループ管理' });
  req.flash('success', 'グループを削除しました');
  res.redirect('/admin/groups');
});

//データの一括ダウンロード
router.get('/backup', isAdmin, async (req, res) => {
  console.log('[/backup] バックアップ処理開始');

  const timestamp = moment().format('YYYYMMDD');
  const serial = '001';
  const fileName = `backup_${timestamp}_${serial}.zip`;
  const tempDir = path.join(__dirname, '../tmp');
  const zipPath = path.join(tempDir, fileName);

  if (!fs.existsSync(tempDir)) {
    console.log('[/backup] 一時ディレクトリが存在しないため作成:', tempDir);
    fs.mkdirSync(tempDir);
  }

  try {
    // モデル一覧を動的に読み込み
    const modelMap = loadBackupModelMap();
    const modelData = {};

    for (const [modelName, model] of modelMap.entries()) {
      try {
        modelData[modelName] = await model.collection.find({}).toArray();
      } catch (e) {
        console.warn(`[/backup] モデル ${modelName} の取得に失敗:`, e.message);
      }
    }

    // 各モデルごとに JSON ファイル出力
    for (const [name, data] of Object.entries(modelData)) {
      fs.writeFileSync(`${tempDir}/${name}.json`, JSON.stringify(data, null, 2));
    }

    console.log('[/backup] ZIPアーカイブ開始');
    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(zipPath);

    const archiveFinished = new Promise((resolve, reject) => {
      output.on('close', () => {
        // console.log('[/backup] ZIPアーカイブ完了 (size:', archive.pointer(), 'bytes)');
        resolve();
      });
      archive.on('error', (err) => {
        console.error('[/backup] アーカイブエラー:', err);
        reject(err);
      });
    });

    archive.pipe(output);
    // すべてのJSONファイルをアーカイブに追加
    const files = fs.readdirSync(tempDir).filter(file => file.endsWith('.json'));
    for (const file of files) {
      archive.file(path.join(tempDir, file), { name: file });
    }
    archive.finalize();

    await archiveFinished;

    console.log('[/backup] ファイルダウンロード開始');
    res.download(zipPath, fileName, (err) => {
      if (err) {
        console.error('[/backup] ダウンロードエラー:', err);
      } else {
        // console.log('[/backup] ダウンロード完了。一時ファイル削除');
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

  } catch (err) {
    console.error('[/backup] 処理中エラー:', err);
    req.flash('error', 'バックアップ中にエラーが発生しました');
    res.redirect('/admin');
  }
});

// バックアップZIPからデータベースを復元（プレビュー）
router.get('/restore', isAdmin, (req, res) => {
  res.render('admin/restore', {
    restorePreview: req.session.restorePreview || null
  });
});

router.post('/restore/preview', isAdmin, restoreUpload.single('backupZip'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      req.flash('error', '復元するZIPファイルを選択してください');
      return res.redirect('/admin/restore');
    }

    const entries = await parseBackupZip(req.file.buffer);
    const readyCount = entries.filter(entry => entry.status === 'ready').length;

    if (readyCount === 0) {
      req.flash('error', '復元可能なJSONファイルがZIP内に見つかりませんでした');
      return res.redirect('/admin/restore');
    }

    if (req.session.restorePreview?.zipPath) {
      fs.rmSync(req.session.restorePreview.zipPath, { force: true });
    }

    const { token, zipPath } = saveRestoreUpload(req.file.buffer);
    req.session.restorePreview = {
      token,
      zipPath,
      originalName: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      entries
    };

    res.redirect('/admin/restore');
  } catch (err) {
    console.error('[admin restore preview] エラー:', err);
    req.flash('error', 'ZIPファイルの読み込みに失敗しました');
    res.redirect('/admin/restore');
  }
});

router.post('/restore/execute', isAdmin, async (req, res) => {
  const preview = req.session.restorePreview;

  try {
    if (!preview?.zipPath || !fs.existsSync(preview.zipPath)) {
      req.flash('error', '復元対象のZIPが見つかりません。もう一度アップロードしてください');
      return res.redirect('/admin/restore');
    }

    if (req.body.confirmText !== 'RESTORE') {
      req.flash('error', '確認文字列が一致しません。RESTORE と入力してください');
      return res.redirect('/admin/restore');
    }

    const zipBuffer = fs.readFileSync(preview.zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const modelMap = loadBackupModelMap();
    const readyEntries = (preview.entries || []).filter(entry => entry.status === 'ready' && modelMap.has(entry.modelName));

    if (readyEntries.length === 0) {
      req.flash('error', '復元可能なモデルがありません');
      return res.redirect('/admin/restore');
    }

    const results = [];
    for (const entry of readyEntries) {
      const model = modelMap.get(entry.modelName);
      const zipEntry = zip.file(entry.fileName);
      if (!zipEntry) {
        results.push({ modelName: entry.modelName, deleted: 0, inserted: 0, status: 'missing_file' });
        continue;
      }

      const docs = JSON.parse(await zipEntry.async('string'));
      if (!Array.isArray(docs)) {
        results.push({ modelName: entry.modelName, deleted: 0, inserted: 0, status: 'not_array' });
        continue;
      }

      const castedDocs = docs.map((doc) => model.castObject(doc));
      const deleteResult = await model.deleteMany({});
      let insertedCount = 0;
      if (castedDocs.length > 0) {
        const insertResult = await model.collection.insertMany(castedDocs, { ordered: true });
        insertedCount = insertResult.insertedCount || castedDocs.length;
      }

      results.push({
        modelName: entry.modelName,
        deleted: deleteResult.deletedCount || 0,
        inserted: insertedCount,
        status: 'restored'
      });
    }

    await logAction({ req, action: 'バックアップZIPからDB復元', target: '管理画面' });
    fs.rmSync(preview.zipPath, { force: true });
    delete req.session.restorePreview;

    const insertedTotal = results.reduce((sum, result) => sum + (result.inserted || 0), 0);
    req.flash('success', `復元が完了しました（${results.length}モデル / ${insertedTotal}件）`);
    res.render('admin/restore', { restorePreview: null, restoreResults: results });
  } catch (err) {
    console.error('[admin restore execute] エラー:', err);
    req.flash('error', `復元に失敗しました: ${err.message}`);
    res.redirect('/admin/restore');
  }
});

//管理画面でのお問合せ一覧表示 (GET /admin/inquiries)
router.get('/inquiries', isAdmin, async (req, res) => {
  const inquiries = await Inquiry.find()
    .populate('user', 'displayname username email')
    .sort({ entry_date: -1 });
  res.render('admin/inquiries', { inquiries });
});

//詳細表示 (GET /admin/inquiries/:id)
router.get('/inquiries/:id', isAdmin, async (req, res) => {
  const inquiry = await Inquiry.findById(req.params.id)
    .populate('user', 'displayname username email')
    .populate('messages.sender', 'displayname username email');
  if (!inquiry) {
    req.flash('error', 'お問い合わせが見つかりません');
    return res.redirect('/admin/inquiries');
  }
  res.render('admin/inquiryDetail', { inquiry });
});

//返信処理 (POST /admin/inquiries/:id/reply)
router.post('/inquiries/:id/reply', isAdmin, async (req, res) => {
  const { replyContent, mail_delivery = 'on' } = req.body;
  const inquiry = await Inquiry.findById(req.params.id).populate('user', 'email');
  if (!inquiry) {
    req.flash('error', 'お問い合わせが見つかりません');
    return res.redirect('/admin/inquiries');
  }
  // メッセージ追加
  const message = {
    content: replyContent,
    sender: req.user._id,
    isAdmin: true,
    mail_delivery: mail_delivery === 'on',
    mail_sent: false,
    entry_date: new Date()
  };
  inquiry.messages.push(message);
  // サポートからの返信は未読として扱う
  inquiry.isRead = false;
  inquiry.closed = req.body.closed === 'on';
  await inquiry.save();

  await Inquiry.findByIdAndUpdate(req.params.id, {
    isRead: false
  });

  // メール送信
  await sendMail({
    to: inquiry.user.email,
    subject: `[回答] ${inquiry.title}`,
    templateName: 'otoiawaseRes',
    templateData: {
      replyContent,
      userEmail: inquiry.user.email,
      title: inquiry.title
    }
  });
  
  // mail_sent フラグ更新
  await Inquiry.findByIdAndUpdate(req.params.id, {
    $set: { 'messages.$[elem].mail_sent': true }
  }, { arrayFilters: [{ 'elem.entry_date': message.entry_date }] });

  req.flash('success', '返信を送信しました');
  res.redirect(`/admin/inquiries/${req.params.id}`);
});

//Q & A管理
// Q&A新規登録画面表示 OK
router.get('/qaEntry', isAdmin, async (req, res) => {
  const qas = await Qa.find().sort({ update_date: -1 });
  const qaCategories = ['サービス全般', '会員について', 'All About me', '家計簿', '資産管理', 'Dashboard', 'その他'];
  res.render('admin/qaEntry', { qas, qaCategories, qa: null });
});

// Q&A新規登録処理
router.post('/qaEntry', isAdmin, async (req, res) => {
  const { qa_category, qa_question, qa_answer, url, faq_flag } = req.body;
  await Qa.create({
    qa_category,
    qa_question,
    qa_answer,
    url,
    faq_flag: faq_flag === 'on',
    entry_date: new Date()
  });
  req.flash('success', 'Q&Aを登録しました');
  res.redirect('/admin/qa');
});


// Q&A一覧表示ページ（詳細操作） OK
router.get('/qa', isAdmin, async (req, res) => {
  const qas = await Qa.find().sort({ update_date: -1 });
  res.render('admin/qaTop', { qas });
});

// 編集画面表示
router.get('/qaEntry/:id/edit', isAdmin, async (req, res) => {
  const qa = await Qa.findById(req.params.id);
  if (!qa) {
    req.flash('error', 'Q&Aが見つかりません');
    return res.redirect('/admin/qa');
  }
  const qaCategories = ['サービス全般', '会員について', 'All About me', '家計簿', '資産管理', 'Dashboard', 'その他'];
  res.render('admin/qaEntry', { qa, qaCategories });
});

// 更新処理
router.put('/qaEntry/:id', isAdmin, async (req, res) => {
  const { qa_category, qa_question, qa_answer, url, faq_flag } = req.body;
  await Qa.findByIdAndUpdate(req.params.id, {
    qa_category,
    qa_question,
    qa_answer,
    url,
    faq_flag: faq_flag === 'on',
    update_date: new Date()
  });
  req.flash('success', 'Q&Aを更新しました');
  res.redirect('/admin/qa');
});

// 削除処理
router.delete('/qaEntry/:id', isAdmin, async (req, res) => {
  await Qa.findByIdAndDelete(req.params.id);
  req.flash('success', 'Q&Aを削除しました');
  res.redirect('/admin/qa');
});

// OCRログの一覧表示
router.get('/ocrs', isAdmin, async (req, res) => {
  // Find all logs, include original and corrected
  const ocrLogs = await OcrLog.find({}).sort({ createdAt: -1 }).limit(100);
  res.render('admin/ocr', {
    ocrLogs,
    showCorrection: true
  });
});

// カテゴリ辞書 管理画面表示（DBから取得）
router.get('/dictionary', isAdmin, async (req, res) => {
  try {
    const entries = await dictentry.find({});
    res.render('admin/dictionary', { dictionary: entries, ex_cfs });
  } catch (err) {
    console.error('辞書読み込みエラー:', err);
    req.flash('error', '辞書の読み込み中にエラーが発生しました');
    res.redirect('/admin');
  }
});

// カテゴリ辞書 保存処理（DBに保存）
router.post('/dictionary/save', isAdmin, async (req, res) => {
  let words = req.body.words || [];
  let categories = req.body.categories || [];

  if (!Array.isArray(words)) words = typeof words === 'string' ? [words] : [];
  if (!Array.isArray(categories)) categories = typeof categories === 'string' ? [categories] : [];

  const updatedEntries = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]?.trim();
    const category = categories[i]?.trim();
    if (word && category) {
      updatedEntries.push({ word, category });
    }
  }

  try {
    await dictentry.deleteMany({});
    if (updatedEntries.length > 0) {
      await dictentry.insertMany(updatedEntries);
      // DBから再取得してJSONファイルに書き出し
      const latestEntries = await dictentry.find({});
      const dictData = {};
      latestEntries.forEach(entry => {
        dictData[entry.word] = entry.category;
      });
      fs.writeFileSync(dictPath, JSON.stringify(dictData, null, 2), 'utf-8');
    }
    req.flash('success', '辞書を更新しました');
    res.redirect('/admin/dictionary');
  } catch (err) {
    console.error('辞書保存エラー:', err);
    req.flash('error', '辞書の保存中にエラーが発生しました');
    res.redirect('/admin/dictionary');
  }
});

// Planner申込み一覧表示
router.get('/planner', isAdmin, async (req, res) => {
  const planners = await Planner.find().populate('user').sort({ entry_date: -1 });
  res.render('admin/planner', { planners });
});

// Planner承認処理
router.post('/planner/:id/approve', isAdmin, async (req, res) => {
  try {
    const planner = await Planner.findById(req.params.id).populate('user');
    if (!planner || !planner.user) {
      req.flash('error', '申込情報が見つかりません');
      return res.redirect('/admin/planner');
    }

    planner.adopt = '採用';
    await planner.save();

    await FinanceUser.findByIdAndUpdate(planner.user._id, {
      isPlanner: true,
      update_date: new Date()
    });

    // PlannerグループIDの取得（固定IDや別の方法で定義されている前提）
    const plannerGroupId = process.env.PLANNER_GROUP_ID;
    if (plannerGroupId) {
      const plannerGroup = await Group.findById(plannerGroupId);
      if (!plannerGroup) {
        throw new Error('Plannerグループが見つかりません');
      }
      if (!plannerGroup.members.some(id => id.equals(planner.user._id))) {
        plannerGroup.members.push(planner.user._id);
        await plannerGroup.save();
      }
    }

    await sendMail({
      to: planner.user.email,
      subject: '【All About me】Planner承認のお知らせ',
      templateName: 'planner_yes',
      templateData: {
        user: planner.user,
        inviteUrl: `${process.env.BASE_URL}/group/group_accept/${plannerGroupId}?email=${planner.user.email}`
      }
    });

    req.flash('success', 'Plannerを承認しました');
    res.redirect('/admin/planner');
  } catch (err) {
    console.error('承認処理エラー:', err);
    req.flash('error', '承認処理でエラーが発生しました');
    res.redirect('/admin/planner');
  }
});

// Planner不承認処理
router.post('/planner/:id/reject', isAdmin, async (req, res) => {
  try {
    const planner = await Planner.findById(req.params.id).populate('user');
    if (!planner || !planner.user) {
      req.flash('error', '申込情報が見つかりません');
      return res.redirect('/admin/planner');
    }

    planner.adopt = '不採用';
    await planner.save();

    await sendMail({
      to: planner.user.email,
      subject: '【All About me】Planner申請結果のお知らせ',
      templateName: 'planner_no',
      templateData: {
        user: planner.user
      }
    });

    req.flash('success', 'Plannerを不承認にしました');
    res.redirect('/admin/planner');
  } catch (err) {
    console.error('不承認処理エラー:', err);
    req.flash('error', '不承認処理でエラーが発生しました');
    res.redirect('/admin/planner');
  }
});

// Planner申し込み削除処理
router.delete('/planner/:id', isAdmin, async (req, res) => {
  try {
    await Planner.findByIdAndDelete(req.params.id);
    req.flash('success', 'Planner申込みを削除しました');
    res.redirect('/admin/planner');
  } catch (err) {
    console.error('削除処理エラー:', err);
    req.flash('error', '削除処理でエラーが発生しました');
    res.redirect('/admin/planner');
  }
});



module.exports = router;
