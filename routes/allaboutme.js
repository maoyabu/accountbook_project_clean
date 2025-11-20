// Web履歴書の表示
// const Resume = require('../models/resume');
// const History = require('../models/history');
// const HistoryCategory = require('../models/historyCategory');
// const path = require('path');

const express = require('express');
const multer = require('multer');
const router = express.Router();
const { getStorage, cloudinary } = require('../cloudinary');
const { isLoggedIn, logAction } = require('../middleware');
const FinanceUser = require('../models/users');
// 履歴書写真アップロード用multer（memoryStorageでバッファ取得）
const multerMemory = multer({ storage: multer.memoryStorage() });
const uploadEventPhotos = () => multer({ storage: getStorage() });
// 履歴書写真アップロード＋Base64保存
router.post('/resume/photo', isLoggedIn, multerMemory.single('photo'), async (req, res) => {
  try {
    const ResumeModel = require('../models/resume');
    const resume = await ResumeModel.findOne({ user: req.user._id }) || new ResumeModel({ user: req.user._id });
    // Base64エンコード
    const base64Photo = req.file
      ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`
      : null;
    if (!req.file) {
      req.flash('error', 'ファイルが選択されていません');
      return res.redirect('/allaboutme/myresume');
    }

    // Cloudinaryを利用できない場合はBase64のみ保存して終了
    if (!cloudinary?.uploader) {
      resume.photoBase64 = base64Photo;
      await resume.save();
      req.flash('success', 'クラウドアップロード不可のためローカル保存しました');
      return res.redirect('/allaboutme/myresume');
    }

    const result = await cloudinary.uploader.upload_stream(
      { folder: 'resume_photos', resource_type: 'image' },
      async (error, uploadResult) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          req.flash('error', '写真のアップロードに失敗しました');
          return res.redirect('/allaboutme/myresume');
        }
        resume.photo_url = uploadResult.secure_url;
        resume.photoBase64 = base64Photo;
        await resume.save();
        req.flash('success', '写真をアップロードしました');
        res.redirect('/allaboutme/myresume');
      }
    );
    // Multer memoryStorageの場合、req.file.bufferをそのままstreamに渡す
    require('stream').Readable.from(req.file.buffer).pipe(result);
    return;
  } catch (err) {
    console.error('履歴書写真アップロードエラー:', err);
    req.flash('error', 'サーバーエラーが発生しました');
    res.redirect('/allaboutme/myresume');
  }
});

// --- Google Photos OAuth2 setup ---
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
let oauth2Client;
function getOAuthClient() {
  if (!oauth2Client) {
    const { google } = require('googleapis');
    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${BASE_URL}/allaboutme/googlePhotos/callback`
    );
  }
  return oauth2Client;
}
// Start Google Photos OAuth2 flow
router.get('/googlePhotos/auth', isLoggedIn, (req, res) => {
  const oauth2Client = getOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// OAuth2 callback
router.get('/googlePhotos/callback', isLoggedIn, async (req, res, next) => {
  try {
    const { code } = req.query;
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    // Save tokens to user record
    const user = await FinanceUser.findById(req.user._id);
    user.googleTokens = tokens;
    await user.save();
    req.flash('success', 'Google Photos との連携に成功しました');
    res.redirect('/allaboutme/eventcal');
  } catch (err) {
    next(err);
  }
});

// Return first 50 media items from Google Photos
router.get('/googlePhotos/list', isLoggedIn, async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user.googleTokens) return res.json({ photos: [] });
    const { google } = require('googleapis');
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(user.googleTokens);
    const photosLib = google.photoslibrary({ version: 'v1', auth: oauth2Client });
    const response = await photosLib.mediaItems.list({ pageSize: 50 });
    res.json(response.data.mediaItems || []);
  } catch (err) {
    next(err);
  }
});

const Wantolist = require('../models/wantolist');
const Eventcal = require('../models/eventcal');
const Eventcal_events = require('../models/eventcal_events');
const SharedAccess = require('../models/shared_access');
// --- カレンダー画面表示（月表示・日別エントリ表示・イベント取得） ---
const dayjs = require('dayjs');
//リマインドメール送信
const cron = require('node-cron');
const { sendMail } = require('../Utils/mailer');

//マイリスト項目定義
const wantolist_items = ['やってて楽しいこと','楽しみにしていること','やってみたいこと','やると決めた事','不安なこと・心配なこと','不満なこと・不快なこと','困っている事','その他'];
// イベント項目定義
const calevent_items = ['今日の気分・体調・睡眠','今日のお食事','生活サイクル','日記'];

router.use((req, res, next) => {
  res.locals.selectedUserId = req.session.selectedUserId || req.user._id.toString();
  next();
});

// マイリスト表示
router.get('/wantolist', isLoggedIn, async (req, res) => {
  const groupId = req.session.activeGroupId;
  const currentUserId = req.user._id.toString();
  const selectedUserId = req.query.userId || currentUserId;
  const fromRelation = req.query.fromRelation === '1';

  // --- access check ---
  const hasAccess = String(selectedUserId) === String(currentUserId) || (
    await SharedAccess.findOne({
      userId: selectedUserId,
      targetUserId: currentUserId,
      sharedTypes: { $in: ['wantolist'] }
    })
  );

  if (!hasAccess) {
    req.flash('error', 'このユーザーのマイリストは表示できません');
    return res.redirect('/myTop/top');
  }

  req.session.selectedUserId = selectedUserId;

  const filter = {
    user: selectedUserId,
    group: groupId
  };
  if (selectedUserId !== currentUserId) {
    filter.share = true;
  }

  const items = await Wantolist.find(filter).sort({ entry_date: -1 });
  const group = await FinanceUser.findById(currentUserId).populate('groups');
  const groupMembers = await FinanceUser.find({ _id: { $in: group.groups[0].members } });

  res.render('allaboutme/wantolist', { items, wantolist_items, groupMembers, selectedUserId });
});

// マイリスト新規作成
router.post('/wantolist', isLoggedIn, async (req, res) => {
    const { item, content, status, share, title } = req.body;
    const newItem = new Wantolist({
        item,
        content,
        status,
        share: share === 'on',
        title,
        user: req.user._id,
        group: req.session.activeGroupId
    });
    await newItem.save();
    await logAction({ req, action: '登録', target: 'allaboutme-list'});
    res.redirect('/allaboutme/wantolist');
});

// マイリスト編集
router.post('/wantolist/:id/edit', isLoggedIn, async (req, res) => {
    const { item, content, status, share, title } = req.body;
    await Wantolist.findOneAndUpdate(
        { _id: req.params.id },
        {
            item,
            content,
            status,
            share: share === 'on',
            title
        }
    );
    await logAction({ req, action: '編集', target: 'allaboutme-list'});
    res.redirect('/allaboutme/wantolist');
});

// マイリスト削除
router.post('/wantolist/:id/delete', isLoggedIn, async (req, res) => {
    await Wantolist.findOneAndDelete({ _id: req.params.id });
    await logAction({ req, action: '削除', target: 'allaboutme-list'});
    res.redirect('/allaboutme/wantolist');
});

//日記
//マイカレンダー表示
router.get('/eventcal', isLoggedIn, async (req, res) => {
  const groupId = req.session.activeGroupId;
  const currentUserId = req.user._id.toString();
  const selectedUserId = req.query.user || req.query.userId || currentUserId;
  const fromRelation = req.query.fromRelation === '1';

  // --- access check ---
  const hasAccess = String(selectedUserId) === String(currentUserId) || (
    await SharedAccess.findOne({
      userId: selectedUserId,
      targetUserId: currentUserId,
      sharedTypes: { $in: ['diary'] }
    })
  );

  if (!hasAccess) {
    req.flash('error', 'このユーザーの日記は表示できません');
    return res.redirect('/myTop/top');
  }

  req.session.selectedUserId = selectedUserId;

  const selectedDate = req.query.date ? new Date(req.query.date) : new Date();
  const startOfDay = new Date(selectedDate.setHours(0, 0, 0, 0));
  const endOfDay = new Date(selectedDate.setHours(23, 59, 59, 999));

  let events = await Eventcal_events.find({ user: currentUserId, group: groupId }).sort({ entry_date: 1 });

  // デフォルトイベントが未登録の場合に自動挿入
  if (events.length === 0) {
    const defaultEvents = [
      { item: '今日の気分・体調・睡眠', event: '今日の気分' },
      { item: '今日の気分・体調・睡眠', event: '今日の体調' },
      { item: '今日の気分・体調・睡眠', event: '今日の睡眠' },
      { item: '今日のお食事', event: '朝食' },
      { item: '今日のお食事', event: 'ランチ' },
      { item: '今日のお食事', event: '夕飯' },
      { item: '今日のお食事', event: 'おやつ' },
      { item: '日記', event: '日記' },
      { item: '生活サイクル', event: '朝食後のお薬' },
      { item: '生活サイクル', event: '昼食後のお薬' },
      { item: '生活サイクル', event: '夕食後のお薬' },
      { item: '生活サイクル', event: 'お散歩' }
    ];

    for (const def of defaultEvents) {
      await new Eventcal_events({
        item: def.item,
        event: def.event,
        user: currentUserId,
        group: groupId
      }).save();
    }

    // 再取得
    events = await Eventcal_events.find({ user: currentUserId, group: groupId }).sort({ entry_date: 1 });
  }

  const filter = {
    user: selectedUserId,
    group: groupId,
    date: { $gte: startOfDay, $lte: endOfDay }
  };
  if (selectedUserId !== currentUserId && !hasAccess) {
    filter.share = true;
  }

  const entries = await Eventcal.find(filter).sort({ entry_date: 1 });
  events = await Eventcal_events.find({ user: currentUserId, group: groupId }).sort({ entry_date: 1 });
  const group = await FinanceUser.findById(currentUserId).populate('groups');
  const groupMembers = await FinanceUser.find({ _id: { $in: group.groups[0].members } });

  // 日記入力済み日付をカレンダー用に取得
  const summaryEntries = await Eventcal.find({
    user: selectedUserId,
    group: groupId
  }, { date: 1 });

  const calendarSummary = {};
  summaryEntries.forEach(entry => {
    const ymd = dayjs(entry.date).format('YYYY-MM-DD');
    calendarSummary[ymd] = true;
  });

  const selectedPhotos = req.session.selectedGooglePhotos || [];
  delete req.session.selectedGooglePhotos;

  const savedForm = req.session.savedEventcalForm || {};
  const selectedItem = req.query.item || savedForm.item || '';
  const selectedEvent = req.query.event || savedForm.event || '';
  const selectedRate = parseInt(req.query.rate || savedForm.rate) || 3;
  const selectedContent = req.query.content || savedForm.content || '';
  delete req.session.savedEventcalForm;

  res.render('allaboutme/eventcal', {
    calevent_items,
    selectedDate: dayjs(startOfDay).format('YYYY-MM-DD'),
    entries,
    events,
    editingEntry: null,
    groupMembers,
    selectedUserId,
    selectedPhotos,
    fromGooglePhoto: req.query.fromGooglePhoto,
    selectedItem,
    selectedEvent,
    selectedRate,
    selectedContent,
    calendarSummary
  });
});

// Google Photosからの写真選択後の処理
router.post('/eventcal/from-google', isLoggedIn, (req, res) => {
  const selectedPhotos = req.body.selectedPhotos;
  // チェックボックスが1つだけの場合、selectedPhotosはstringになる
  const normalizedPhotos = Array.isArray(selectedPhotos) ? selectedPhotos : (selectedPhotos ? [selectedPhotos] : []);

  // 選択された写真のURLをセッションに一時保存
  req.session.selectedGooglePhotos = normalizedPhotos;

  const { item = '', event = '', rate = 3, content = '' } = req.body;
  req.session.savedEventcalForm = { item, event, rate, content };
  req.flash('success', '写真を選択しました');
  res.redirect(`/allaboutme/eventcal?fromGooglePhoto=true&item=${encodeURIComponent(item)}&event=${encodeURIComponent(event)}&rate=${rate}&content=${encodeURIComponent(content)}`);
});
//日記の一時登録



// 日記登録処理（モーダル登録フロー） with photo upload
router.post('/eventcal', isLoggedIn, uploadEventPhotos().array('photos', 5), async (req, res) => {
    //const { date, item, event, rate, content, share } = req.body;
    const { date, item, event, rate, content, share, title, summary, saveAction, existingId } = req.body;
    // Unified photo object handling
    let photoObjs = (req.files || []).map(f => ({
      url: f.path,
      source: 'cloudinary'
    }));

    if (req.session.selectedGooglePhotos) {
      photoObjs = photoObjs.concat(
        req.session.selectedGooglePhotos.map(url => ({ url, source: 'google' }))
      );
      delete req.session.selectedGooglePhotos;
    }
    // Also collect selectedGooglePhotos from request body if available
    const selectedFromBody = req.body.selectedGooglePhotos;
    if (selectedFromBody) {
      const selectedArray = Array.isArray(selectedFromBody) ? selectedFromBody : [selectedFromBody];
      photoObjs = photoObjs.concat(selectedArray.map(url => ({ url, source: 'google' })));
    }
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const existing = await Eventcal.findOne({
        user: req.user._id,
        group: req.session.activeGroupId,
        date: { $gte: start, $lte: end },
        item: item,
        event: event
    });

    if (existing) {
      // 既存レコードがある場合、モデルの saveAction を見て判定する
      // draft なら上書き更新OK、final または未定義なら重複エラーとして弾く
      const isExistingDraft = existing.saveAction === 'draft' || !existing.saveAction;
      if (isExistingDraft) {
        // 既存の写真と今回のアップロード・選択写真を統合（重複排除）
        let mergedPhotos = Array.isArray(photoObjs) ? [...photoObjs] : [];
        if (Array.isArray(existing.photos)) {
          for (const p of existing.photos) {
            const url = typeof p === 'string' ? p : p.url;
            const source = typeof p === 'string'
              ? (url && url.startsWith('http') ? 'google' : 'local')
              : (p.source || (p.url && p.url.startsWith('http') ? 'google' : 'local'));
            if (url && !mergedPhotos.some(ph => ph.url === url)) {
              mergedPhotos.push({ url, source });
            }
          }
        }

        const parsedRate = parseInt(rate);
        const safeRate = isNaN(parsedRate) ? 3 : parsedRate;

        await Eventcal.findByIdAndUpdate(
          existing._id,
          {
            date,
            item,
            event,
            rate: safeRate,
            content,
            title,
            summary,
            // saveAction はフォーム指定が draft なら draft、そうでなければ final
            saveAction: (saveAction === 'draft') ? 'draft' : 'final',
            // 下書きなら非公開、本保存ならフォーム値に従う
            share: (saveAction === 'draft') ? false : (share === 'on'),
            photos: mergedPhotos
          }
        );

        await logAction({ req, action: (saveAction === 'draft') ? '下書き更新' : '更新', target: 'allaboutme-日記'});

        // 下書き(AJAX)の場合はJSONを返す（モーダルを閉じない）
        if (saveAction === 'draft' && (req.xhr || (req.get('X-Requested-With') === 'XMLHttpRequest'))) {
          return res.json({ ok: true, id: existing._id.toString() });
        }

        return res.redirect(`/allaboutme/eventcal?date=${date}`);
      } else {
        // final（確定済み）だった場合は重複としてエラー扱い
        req.flash('error', '同じ日・同じ項目・同じイベントにはすでに登録があります');
        return res.redirect(`/allaboutme/eventcal?date=${date}`);
      }
    }

    const newEntry = new Eventcal({
      date,
      item,
      event,
      rate: parseInt(rate),
      content,
      title,
      summary,
      share: (saveAction === 'draft') ? false : (share === 'on'),
      saveAction: (saveAction === 'draft') ? 'draft' : 'final',
      user: req.user._id,
      group: req.session.activeGroupId
    });

    // Ensure photos are saved on the new entry
    if (photoObjs.length) newEntry.photos = photoObjs;

    await newEntry.save();
    await logAction({ req, action: '登録', target: 'allaboutme-日記'});

    // If AJAX draft save, return JSON and keep modal open on client
    if (saveAction === 'draft' && (req.xhr || (req.get('X-Requested-With') === 'XMLHttpRequest'))) {
      return res.json({ ok: true, id: newEntry._id.toString() });
    }

    res.redirect(`/allaboutme/eventcal?date=${date}`);
});

// 日記編集画面表示
router.get('/eventcal/edit/:id', isLoggedIn, async (req, res) => {
  const entry = await Eventcal.findOne({
    _id: req.params.id,
    user: req.user._id,
    group: req.session.activeGroupId
  });

  if (!entry) {
    req.flash('error', '編集対象の記録が見つかりません');
    return res.redirect('/allaboutme/eventcal');
  }

  // entry.date is mutated below, so use two copies
  const entryDateStart = new Date(entry.date);
  entryDateStart.setHours(0, 0, 0, 0);
  const entryDateEnd = new Date(entry.date);
  entryDateEnd.setHours(23, 59, 59, 999);

  const entries = await Eventcal.find({
    user: req.user._id,
    group: req.session.activeGroupId,
    date: {
      $gte: entryDateStart,
      $lte: entryDateEnd
    }
  }).sort({ entry_date: 1 });

  const events = await Eventcal_events.find({ user: req.user._id, group: req.session.activeGroupId }).sort({ entry_date: 1 });
  const group = await FinanceUser.findById(req.user._id).populate('groups');
  const groupMembers = await FinanceUser.find({ _id: { $in: group.groups[0].members } });
  const selectedUserId = req.user._id.toString();

  // 日記入力済み日付をカレンダー用に取得
  const summaryEntries = await Eventcal.find({
    user: selectedUserId,
    group: req.session.activeGroupId
  }, { date: 1 });

  const calendarSummary = {};
  summaryEntries.forEach(entry => {
    const ymd = dayjs(entry.date).format('YYYY-MM-DD');
    calendarSummary[ymd] = true;
  });

  // Normalize entry.photos to always be array of {url, source}
  const selectedPhotos = (entry.photos || []).map(photo => {
    if (typeof photo === 'string') {
      return { url: photo, source: photo.startsWith('http') ? 'google' : 'local' };
    }
    return photo;
  });

  res.render('allaboutme/eventcal', {
    calevent_items,
    selectedDate: dayjs(entry.date).format('YYYY-MM-DD'),
    entries,
    events,
    editingEntry: entry,
    groupMembers,
    selectedUserId,
    selectedPhotos,
    fromGooglePhoto: false,
    selectedItem: entry.item || '',
    selectedEvent: entry.event || '',
    selectedRate: entry.rate || 3,
    selectedContent: entry.content || '',
    calendarSummary
  });
});

// 日記削除処理
router.post('/eventcal/delete/:id', isLoggedIn, async (req, res) => {
  const entry = await Eventcal.findOne({
    _id: req.params.id,
    user: req.user._id,
    group: req.session.activeGroupId
  });

  if (!entry) {
    req.flash('error', '削除対象の記録が見つかりません');
    return res.redirect('/allaboutme/eventcal');
  }

  await Eventcal.deleteOne({ _id: req.params.id });
  await logAction({ req, action: '削除', target: 'allaboutme-日記'});
  res.redirect(`/allaboutme/eventcal?date=${dayjs(entry.date).format('YYYY-MM-DD')}`);
});

// 日記更新処理 (with photo upload and Google Photos integration)
router.post('/eventcal/edit/:id', isLoggedIn, uploadEventPhotos().array('photos', 5), async (req, res) => {
  //const { date, item, event, rate, content, share } = req.body;
  const { date, item, event, rate, content, share, title, summary, saveAction } = req.body;

  // Unified photo object handling with deletion support
  let photoObjs = (req.files || []).map(f => ({
    url: f.path,
    source: 'cloudinary'
  }));

  // Get existing entry to merge old photos
  const existingEntry = await Eventcal.findOne({
    _id: req.params.id,
    user: req.user._id,
    group: req.session.activeGroupId
  });
  let oldPhotos = [];
  if (existingEntry && Array.isArray(existingEntry.photos)) {
    oldPhotos = existingEntry.photos;
  }
  // Add old photos (not newly uploaded) to photoObjs
  for (const p of oldPhotos) {
    // If url not already present (avoid duplicates)
    if (!photoObjs.some(photo => photo.url === (p.url || p))) {
      // Normalize structure if needed
      if (typeof p === 'string') {
        photoObjs.push({ url: p, source: p.startsWith('http') ? 'google' : 'local' });
      } else {
        photoObjs.push(p);
      }
    }
  }

  if (req.session.selectedGooglePhotos) {
    const newGooglePhotos = req.session.selectedGooglePhotos
      .filter(url => !photoObjs.some(p => p.url === url))
      .map(url => ({ url, source: 'google' }));
    photoObjs = photoObjs.concat(newGooglePhotos);
    delete req.session.selectedGooglePhotos;
  }
  // Also collect selectedGooglePhotos from request body if available
  const selectedFromBody = req.body.selectedGooglePhotos;
  if (selectedFromBody) {
    const selectedArray = Array.isArray(selectedFromBody) ? selectedFromBody : [selectedFromBody];
    const newFromBody = selectedArray
      .filter(url => !photoObjs.some(p => p.url === url))
      .map(url => ({ url, source: 'google' }));
    photoObjs = photoObjs.concat(newFromBody);
  }

  // Support photo deletion: filter out URLs in req.body.deletePhotoUrls
  const deleteUrls = req.body.deletePhotoUrls;
  const deleteSet = new Set(
    Array.isArray(deleteUrls) ? deleteUrls : deleteUrls ? [deleteUrls] : []
  );

  // Delete cloudinary images
  if (cloudinary?.uploader) {
    for (const url of deleteSet) {
      if (url.startsWith('https://res.cloudinary.com/')) {
        const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.(jpg|jpeg|png|gif|webp)$/);
        if (match) {
          const publicId = match[1];
          await cloudinary.uploader.destroy(publicId).catch(err => {
            console.warn(`Cloudinary削除失敗: ${publicId}`, err);
          });
        }
      }
    }
  }

  photoObjs = photoObjs.filter(photo => !deleteSet.has(photo.url));

  const parsedRate = parseInt(rate);
  const safeRate = isNaN(parsedRate) ? 3 : parsedRate;

  await Eventcal.findOneAndUpdate(
    {
      _id: req.params.id,
      user: req.user._id,
      group: req.session.activeGroupId
    },
    {
      date,
      item,
      event,
      rate: safeRate,
      content,
      title,
      summary,
      share: (saveAction === 'draft') ? false : (share === 'on'),
      saveAction: (saveAction === 'draft') ? 'draft' : 'final',
      photos: photoObjs
    }
  );

  await logAction({ req, action: '更新', target: 'allaboutme-日記'});

  if (saveAction === 'draft' && (req.xhr || (req.get('X-Requested-With') === 'XMLHttpRequest'))) {
    return res.json({ ok: true, id: req.params.id });
  }

  res.redirect(`/allaboutme/eventcal?date=${date}`);
});

// 日記用イベント登録画面の表示
router.get('/eventcal_events', isLoggedIn, async (req, res) => {
  const userId = req.user._id;
  const groupId = req.session.activeGroupId;
  let events = await Eventcal_events.find({ user: userId, group: groupId }).sort({ display_order: 1, entry_date: -1 });

  // デフォルトイベント挿入
  if (events.length === 0) {
    const defaultEvents = [
      { item: '今日の気分・体調・睡眠', event: '今日の気分' },
      { item: '今日の気分・体調・睡眠', event: '今日の体調' },
      { item: '今日の気分・体調・睡眠', event: '今日の睡眠' },
      { item: '今日のお食事', event: '朝食' },
      { item: '今日のお食事', event: 'ランチ' },
      { item: '今日のお食事', event: '夕飯' },
      { item: '今日のお食事', event: 'おやつ' },
      { item: '生活サイクル', event: '朝食後のお薬' },
      { item: '生活サイクル', event: '昼食後のお薬' },
      { item: '生活サイクル', event: '夕食後のお薬' },
      { item: '生活サイクル', event: 'お散歩' },
      { item: '日記', event: '日記' },
    ];

    for (const def of defaultEvents) {
      await new Eventcal_events({
        item: def.item,
        event: def.event,
        user: userId,
        group: groupId
      }).save();
    }

    // 再取得
    events = await Eventcal_events.find({ user: userId, group: groupId }).sort({ entry_date: -1 });
  }

  
  let editingEvent = null;
  if (req.query.edit) {
    editingEvent = await Eventcal_events.findOne({ _id: req.query.edit, user: userId, group: groupId });
  }

  res.render('allaboutme/eventcal_events', { events, calevent_items, editingEvent });
});

// 日記用イベントの登録
router.post('/eventcal_events', isLoggedIn, async (req, res) => {
  const { item, event } = req.body;
  if (!item || !event) {
    req.flash('error', '項目名とイベント名は必須です');
    return res.redirect('/allaboutme/eventcal_events');
  }

  // Determine display_order: from form or auto-increment
  let display_order = 0;
  if (req.body.display_order !== undefined && req.body.display_order !== '') {
    display_order = Number(req.body.display_order);
    if (isNaN(display_order)) display_order = 0;
  } else {
    // Auto-increment: get current max for this user/group
    const count = await Eventcal_events.countDocuments({ user: req.user._id, group: req.session.activeGroupId });
    display_order = count + 1;
  }

  const newEvent = new Eventcal_events({
    display_order,
    item,
    event,
    user: req.user._id,
    group: req.session.activeGroupId
  });
  await newEvent.save();
  await logAction({ req, action: '登録', target: 'allaboutme-event'});
  res.redirect('/allaboutme/eventcal_events');
});

// 日記用イベントの編集
router.post('/eventcal_events/:id/edit', isLoggedIn, async (req, res) => {
  const { item, event } = req.body;
  await Eventcal_events.findOneAndUpdate(
    { _id: req.params.id },
    { item, event, display_order: req.body.display_order }
  );
  await logAction({ req, action: '更新', target: 'allaboutme-event'});
  res.redirect('/allaboutme/eventcal_events');
});

// 日記削除
router.post('/eventcal_events/:id/delete', isLoggedIn, async (req, res) => {
  await Eventcal_events.findByIdAndDelete(req.params.id);
  await logAction({ req, action: '削除', target: 'allaboutme-event'});
  res.redirect('/allaboutme/eventcal_events');
});

//リマインドメールの送信　毎朝8時
cron.schedule('0 8 * * *', async () => {
  const users = await FinanceUser.find({});
  const baseUrl = process.env.NODE_ENV === 'production' ? process.env.BASE_URL : 'http://localhost:3000';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const endOfYesterday = new Date(yesterday);
  endOfYesterday.setHours(23, 59, 59, 999);
  const ymd = yesterday.toISOString().split('T')[0];
  const Eventcal = require('../models/eventcal');

  for (const user of users) {
    if (user.isMail === false) continue;
    if (!user.email) continue;

    const hasDiary = await Eventcal.exists({
      user: user._id,
      date: { $gte: yesterday, $lte: endOfYesterday }
    });

    if (hasDiary) continue;

    const fullUrl = `${baseUrl}/allaboutme/eventcal?date=${ymd}`;
    try {
      await sendMail({
        to: user.email,
        subject: '日記の記入リマインダー',
        templateName: 'diaryReminder',
        templateData: {
          name: user.displayname || user.username,
          url: fullUrl,
          date: ymd
        }
      });
    } catch (err) {
      console.error(`メール送信エラー（${user.email}）:`, err);
    }
  }
});

// 指定日の日記を一覧取得（モーダル用）
router.get('/eventcal/day-detail', isLoggedIn, async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const entries = await Eventcal.find({
    user: req.user._id,
    group: req.session.activeGroupId,
    date: { $gte: start, $lte: end }
  }).sort({ entry_date: 1 });

  // 写真URLの正規化
  const normalized = entries.map(entry => ({
    item: entry.item,
    event: entry.event,
    rate: entry.rate,
    title: entry.title,
    summary: entry.summary,
    content: entry.content,
    photos: (entry.photos || []).map(p => typeof p === 'string' ? { url: p } : p)
  }));

  res.json(normalized);
});

// 内容を要約して返す（JSON）: { summary }
router.post('/eventcal/summarize', isLoggedIn, express.json(), async (req, res) => {
  try {
    const { content, maxChars = 180, lang = 'ja' } = req.body || {};
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).send('content is required');
    }

    const clipped = content.slice(0, 4000);

    const prompt = `あなたは有能な要約アシスタントです。
次の本文を${lang}で、読みやすく自然な短い要約にしてください。
- 最大${maxChars}文字目安（少し超えるのは可）
- 文は完結に。体言止めでも可
- 箇条書き禁止。1〜2文で

本文:
${clipped}`;

    const client = getOpenAI();
    if (!client) {
      return res.status(503).send('OpenAI未設定のため要約できません');
    }

    const resp = await client.chat.completions.create({
      model: SUMM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 300
    });

    const summary = resp.choices?.[0]?.message?.content?.trim() || '';
    if (!summary) return res.status(502).send('summary generation failed');
    return res.json({ summary });
  } catch (e) {
    console.error('summarize error:', e);
    return res.status(500).send('failed to summarize');
  }
});

// 一括入力開始
router.get('/eventcal/batch', isLoggedIn, async (req, res) => {
  const userId = req.user._id;
  const groupId = req.session.activeGroupId;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const events = await Eventcal_events.find({ user: userId, group: groupId }).sort({ display_order: 1, entry_date: -1 });

  req.session.batchEventIndex = 0;
  req.session.batchEvents = events;
  req.session.batchEventDate = date;

  res.redirect('/allaboutme/eventcal/batch/step');
});

// 1件ずつ表示
router.get('/eventcal/batch/step', isLoggedIn, async (req, res) => {
  const { batchEventIndex = 0, batchEvents = [], batchEventDate } = req.session;
  const currentEvent = batchEvents[batchEventIndex];

  if (!currentEvent) {
    req.flash('success', '一括入力が完了しました');
    return res.redirect(`/allaboutme/eventcal?date=${batchEventDate}`);
  }

  const userId = req.user._id;
  const groupId = req.session.activeGroupId;
  const date = new Date(batchEventDate);
  const start = new Date(date.setHours(0, 0, 0, 0));
  const end = new Date(date.setHours(23, 59, 59, 999));

  const existingEntry = await Eventcal.findOne({
    user: userId,
    group: groupId,
    date: { $gte: start, $lte: end },
    item: currentEvent.item,
    event: currentEvent.event
  });

  res.render('allaboutme/eventcal_batch', {
    selectedDate: req.session.batchEventDate,
    eventObj: currentEvent,
    existingEntry,
    batchEventIndex,
    batchEventsTotal: batchEvents.length
  });
});

// ステップ入力処理
router.post('/eventcal/batch/step', isLoggedIn, uploadEventPhotos().array('photos', 5), async (req, res) => {
  const action = req.body.action;
  //const { item, event, rate, content, share, date } = req.body;
  const { item, event, rate, content, share, date, title, summary } = req.body;
  const userId = req.user._id;
  const groupId = req.session.activeGroupId;

  if (action && action === 'save') {
    try {
      // Cloudinary
      let photoObjs = (req.files || []).map(f => ({
        url: f.path,
        source: 'cloudinary'
      }));

      const newEntry = new Eventcal({
        date,
        item,
        event,
        rate: parseInt(rate),
        content,
        title,
        summary,
        share: share === 'on',
        user: userId,
        group: groupId
      });

      if (photoObjs.length > 0) {
        newEntry.photos = photoObjs;
      }

      await newEntry.save();
    } catch (err) {
      console.error('バッチ登録エラー:', err);
    }
  }

  req.session.batchEventIndex++;
  res.redirect('/allaboutme/eventcal/batch/step');
});

//All About meのレポート機能
const moment = require('moment');
// --- AI要約 用（OpenAI） ---
const OpenAI = require('openai');
let openaiClient;
const SUMM_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MyList = require('../models/wantolist');

function getOpenAI() {
  if (openaiClient) return openaiClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('⚠️ OPENAI_API_KEY が未設定のため要約をスキップします');
    return null;
  }
  openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

// マイリストの月次レポート: 年・月クエリ対応
router.get('/report/mylist', isLoggedIn, async (req, res) => {
  const groupId = req.session.activeGroupId;
  const userId = req.user._id;
  const currentUser = req.user;

  const now = new Date();
  const year = parseInt(req.query.year) || now.getFullYear();
  const month = parseInt(req.query.month) || now.getMonth() + 1;

  // 月初・月末
  const startOfMonth = new Date(year, month - 2, 1);
  const endOfMonth = new Date(year, month - 1, 0, 23, 59, 59, 999);

  // 新規追加
  const newItems = await MyList.find({
    user: userId,
    group: groupId,
    entry_date: { $gte: startOfMonth, $lte: endOfMonth }
  }).sort({ entry_date: -1 });

  // 完了/破棄
  const completedItems = await MyList.find({
    user: userId,
    group: groupId,
    update_date: { $gte: startOfMonth, $lte: endOfMonth },
    status: { $in: ['実現・解決', '破棄'] }
  }).sort({ update_date: -1 });

  // My日記レポート用データの取得
  const Diary = require('../models/eventcal');
  // 月初・月末をmomentで厳密に（ISOフォーマット対応・警告回避）
  const paddedMonth = String(month).padStart(2, '0');
  const startOfMonthMoment = moment(`${year}-${paddedMonth}-01`, 'YYYY-MM-DD').startOf('month').toDate();
  const endOfMonthMoment = moment(`${year}-${paddedMonth}-01`, 'YYYY-MM-DD').endOf('month').toDate();

  const diaryEntries = await Diary.find({
    user: req.user._id,
    group: req.session.activeGroupId,
    date: { $gte: startOfMonthMoment, $lte: endOfMonthMoment }
  });

  const myDiarySummary = [];
  const grouped = {};

  diaryEntries.forEach(entry => {
    const category = entry.item;
    const name = entry.event;
    const value = Number(entry.rate);

    if (!value || value < 1 || value > 5) return;

    if (!grouped[category]) {
      grouped[category] = {};
    }
    if (!grouped[category][name]) {
      grouped[category][name] = { sum: 0, count: 0, detail: {} };
    }

    grouped[category][name].sum += value;
    grouped[category][name].count += 1;
    grouped[category][name].detail[value] = (grouped[category][name].detail[value] || 0) + 1;
  });

  for (const category in grouped) {
    const items = [];
    for (const name in grouped[category]) {
      const data = grouped[category][name];
      items.push({
        name,
        avg: data.sum / data.count,
        count: data.count,
        detail: data.detail
      });
    }
    myDiarySummary.push({ title: category, items });
  }

  const currentYear = new Date().getFullYear();
  res.render('allaboutme/report', {
    currentUser: req.user,
    currentYear,
    year,
    month,
    newItems,
    completedItems,
    myDiarySummary
  });
});

// 日記書き出し条件入力画面
router.get('/export-diary', async (req, res) => {
  try {
    const entries = await Eventcal_events.find({
      user: req.user._id,
      item: '日記'
    });

    // 重複を排除してeventのみ抽出
    const eventSet = new Set();
    entries.forEach(entry => {
      if (entry.event) {
        eventSet.add(entry.event);
      }
    });

    const diaryTypes = Array.from(eventSet); // => ['日記', '開発日記']

    res.render('allaboutme/selection', { diaryTypes });
  } catch (err) {
    console.error('Error loading diary export selection:', err);
    res.status(500).send('エラーが発生しました');
  }
});


//　1列タイプの日記表示
router.post('/export-diary/one', async (req, res) => {
  try {
    const { from, to, event } = req.body;

    const startDate = new Date(from);
    const endDate = new Date(to);

    // 日付バリデーション
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).send('無効な日付が指定されました');
    }

    endDate.setHours(23, 59, 59, 999); // include entire end day

    const entries = await Eventcal.find({
      user: req.user._id,
      date: { $gte: startDate, $lte: endDate },
      event
    }).sort({ date: 1 });

    const formatted = entries.map(e => ({
      dateStr: e.date.toISOString().split('T')[0],
      rating: e.rate || 0,
      content: e.content || ''
    }));

    res.render('allaboutme/diaryOne', { entries: formatted, from, to, event });
  } catch (err) {
    console.error('Error rendering diary one:', err);
    res.status(500).send('エラーが発生しました');
  }
});

//　2列タイプの日記表示
router.post('/export-diary/two', async (req, res) => {
  try {
    const { from, to, event } = req.body;

    const startDate = new Date(from);
    const endDate = new Date(to);

    // 日付バリデーション
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).send('無効な日付が指定されました');
    }

    endDate.setHours(23, 59, 59, 999); // include entire end day

    const entries = await Eventcal.find({
      user: req.user._id,
      date: { $gte: startDate, $lte: endDate },
      event
    }).sort({ date: 1 });

    const formatted = entries.map(e => ({
      dateStr: e.date.toISOString().split('T')[0],
      rating: e.rate || 0,
      content: e.content || ''
    }));

    res.render('allaboutme/diaryTwo', { entries: formatted, from, to, event });
  } catch (err) {
    console.error('Error rendering diary two:', err);
    res.status(500).send('エラーが発生しました');
  }
});

module.exports = router;
