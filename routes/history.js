const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const HistoryCategory = require('../models/historyCategory');
const History = require('../models/history'); // 🔹 ルート上部で読み込み済みでなければ追加
const SharedAccess = require('../models/shared_access');
const { isLoggedIn } = require('../middleware');
const multer = require('multer');
const { getStorage, cloudinary } = require('../cloudinary'); // your configured Cloudinary multer storage
const upload = () => multer({ storage: getStorage() });
// --- Google Photos OAuth2 setup ---
const { google } = require('googleapis');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/history/googlePhotos/callback`
);
// Start Google Photos OAuth2 flow
router.get('/googlePhotos/auth', isLoggedIn, (req, res) => {
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
    const { tokens } = await oauth2Client.getToken(code);
    // Save tokens to user record
    const user = await FinanceUser.findById(req.user._id);
    user.googleTokens = tokens;
    await user.save();
    req.flash('success', 'Google Photos との連携に成功しました');
    res.redirect('/history/entry');
  } catch (err) {
    next(err);
  }
});

// Return first 50 media items from Google Photos
router.get('/googlePhotos/list', isLoggedIn, async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user.googleTokens) return res.json({ photos: [] });
    oauth2Client.setCredentials(user.googleTokens);
    const photosLib = google.photoslibrary({ version: 'v1', auth: oauth2Client });
    const response = await photosLib.mediaItems.list({ pageSize: 50 });
    res.json(response.data.mediaItems || []);
  } catch (err) {
    next(err);
  }
});

// カテゴリー一覧と新規作成表示
router.get('/categories', isLoggedIn, async (req, res) => {
  const categories = await HistoryCategory.find({ user: req.user._id }).sort({ update_date: -1 });
  res.render('allaboutme/category', { categories });
});

// カテゴリー新規作成処理
router.post('/categories', isLoggedIn, async (req, res) => {
  try {
    const { name, field_names = [], field_types = [], color = '#000000' } = req.body;
    const fields = [];

    for (let i = 0; i < field_names.length; i++) {
      if (field_names[i].trim()) {
        fields.push({ name: field_names[i].trim(), type: field_types[i] });
      }
    }

    await HistoryCategory.create({
      name,
      fields,
      color,
      user: req.user._id,
      entry_date: new Date(),
      update_date: new Date(),
      // This is the key change: req.body.share will only exist if the checkbox was checked.
      share: !!req.body.share // Converts 'on' to true, undefined to false
    });

    req.flash('success', 'カテゴリーを作成しました');
    res.redirect('/history/categories');
  } catch (err) {
    console.error('❌ カテゴリー作成エラー:', err);
    req.flash('error', 'カテゴリーの作成に失敗しました');
    res.render('allaboutme/category', {
      name: req.body.name,
      field_names: req.body.field_names,
      field_types: req.body.field_types,
      color: req.body.color || '#000000',
      share: !!req.body.share // Also update this for re-rendering in case of error
    });
  }
});

// カテゴリー編集フォーム表示
router.get('/categories/:id/edit', isLoggedIn, async (req, res) => {
  const category = await HistoryCategory.findById(req.params.id);
  
  if (!category || category.user.toString() !== req.user._id.toString()) {
    req.flash('error', 'このカテゴリーは編集できません');
    return res.redirect('/history/categories');
  }

  res.render('allaboutme/categoryEdit', {
    category,
    color: category.color || '#000000'
  });
});

// カテゴリー編集の保存処理
router.post('/categories/:id', isLoggedIn, async (req, res) => {
  const { id } = req.params;
  let { name, field_names = [], field_types = [], color, share } = req.body;
  if (!color) color = '#000000'; // fallback if color is missing

  // フィールドをオブジェクト形式に変換
  let fields = [];

  if (Array.isArray(field_names)) {
    fields = field_names.map((fname, i) => ({
      name: fname?.trim() || '',
      type: Array.isArray(field_types) ? (field_types[i] || 'text') : (field_types || 'text')
    })).filter(f => f.name);
  } else if (typeof field_names === 'string' && typeof field_types === 'string') {
    fields.push({ name: field_names.trim(), type: field_types });
  } else {
    req.flash('error', 'フィールド情報が正しくありません');
    return res.redirect('/history/categories');
  }

  try {
    await HistoryCategory.findByIdAndUpdate(id, {
      name,
      fields,
      color,
      update_date: new Date(),
      share: share === 'on' || share === true
    });

    req.flash('success', 'カテゴリーを更新しました');
    res.redirect('/history/categories');
  } catch (err) {
    console.error('編集エラー:', err);
    req.flash('error', 'カテゴリーの更新に失敗しました');
    res.redirect('/history/categories');
  }
});

// カテゴリー削除処理
router.post('/categories/:id/delete', isLoggedIn, async (req, res) => {
  try {
    await HistoryCategory.findByIdAndDelete(req.params.id);
    req.flash('success', 'カテゴリーを削除しました');
  } catch (err) {
    console.error('❌ カテゴリー削除エラー:', err);
    req.flash('error', 'カテゴリーの削除に失敗しました');
  }
  res.redirect('/history/categories');
});

//my History登録画面　表示
router.get('/entry', isLoggedIn, async (req, res) => {
  const categories = await HistoryCategory.find({ user: req.user._id, isActive: true });
  res.render('allaboutme/historyEntry', { categories });
});

//フィールド構成取得用のAPI
router.get('/category-fields/:id', isLoggedIn, async (req, res) => {
  const category = await HistoryCategory.findById(req.params.id);
  res.json(category);
});

//my History登録のルート
router.post('/entry', isLoggedIn, upload().array('photos', 10), async (req, res) => {

    try {
        const { categoryId, from_date, end_date, url, content, share = true } = req.body;


        let category = null;
        if (mongoose.Types.ObjectId.isValid(categoryId)) {
            category = await HistoryCategory.findById(categoryId);
        }

        if (!category) {
            console.error('❌ Invalid or missing categoryId:', categoryId);
            req.flash('error', 'カテゴリーが見つかりません');
            return res.redirect('back');
        }

        const data = {};
        for (const key in req.body) {
            if (key.startsWith('data_')) {
                const index = key.substring(5); // 'data_' の後の index を取得
                const fieldName = category.fields[parseInt(index)]?.name; // index を使って元のフィールド名を取得
                if (fieldName) {
                    data[fieldName] = req.body[key];
                }
            }
        }

        const uploadedPhotos = req.files?.map(file => ({
          url: file.path,
          source: 'cloudinary'
        })) || [];

        const selectedGooglePhotos = (Array.isArray(req.body.selectedGooglePhotos) ? req.body.selectedGooglePhotos : [req.body.selectedGooglePhotos])
          .filter(url => !!url)
          .map(url => ({
            url,
            source: 'google'
          }));

        const photos = [...uploadedPhotos, ...selectedGooglePhotos];

        await History.create({
            category: categoryId,
            user: req.user._id,
            data,
            from_date: from_date || null,
            end_date: end_date || null,
            url,
            content,
            isActive: req.body.isActive === 'true',
            share: share === 'on' || share === true,
            entry_date: new Date(),
            update_date: new Date(),
            photos
        });

        req.flash('success', 'myhistoryを登録しました');
        res.redirect('/history/list');
    } catch (err) {
        console.error('myhistory登録エラー:', err);
        req.flash('error', 'myhistoryの登録に失敗しました');
        res.redirect('/history/entry');
    }
});

//myhistory一覧表示（カテゴリー絞り込み対応・SharedAccess権限チェック）
router.get('/list', isLoggedIn, async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const selectedUserId = req.query.user || currentUserId;

    // 自分以外を見ようとした場合はSharedAccessを確認
    if (selectedUserId.toString() !== currentUserId.toString()) {
      const hasAccess = await SharedAccess.findOne({
        userId: selectedUserId,
        targetUserId: currentUserId,
        sharedTypes: { $in: ['history'] }
      });
      if (!hasAccess) {
        req.flash('error', 'このユーザーのMyHistoryを表示する権限がありません');
        return res.redirect('/myTop/top');
      }
    }

    const selectedCategory = req.query.category || null;

    const categories = await HistoryCategory.find({ user: selectedUserId, isActive: true });

    const filter = { user: selectedUserId };
    if (selectedCategory) {
      filter.category = selectedCategory;
    }

    const histories = await History.find(filter)
      .populate('category')
      .sort({ from_date: -1 });

    // Fetch group members logic with group object preserved
    const groupMembers = [];
    const groupIds = req.user.groups || [];
    let group = null;
    if (groupIds.length > 0) {
      const Group = mongoose.model('Group');
      const User = mongoose.model('User');
      group = await Group.findById(groupIds[0]).populate('members');
      if (group && group.members) {
        group.members.forEach(member => groupMembers.push(member));
      }
    }

    res.render('allaboutme/history', {
      histories,
      categories,
      selectedCategory,
      selectedUserId: selectedUserId.toString(),
      currentUser: await mongoose.model('User').findById(req.user._id).populate('groups'),
      groupMembers,
      group
    });
  } catch (err) {
    console.error('myhistory一覧取得エラー:', err);
    req.flash('error', 'myhistoryの取得に失敗しました');
    res.redirect('/');
  }
});

// myhistory編集フォーム表示
router.get('/edit/:id', isLoggedIn, async (req, res) => {
  try {
    const history = await History.findById(req.params.id).populate('category');
    if (!history) {
      req.flash('error', 'myhistoryが見つかりません');
      return res.redirect('/history/list');
    }
    const categories = await HistoryCategory.find({ user: req.user._id, isActive: true });
    res.render('allaboutme/historyEdit', {
      history,
      categories,
      selectedGooglePhotos: (() => {
        const selected = req.session.selectedGooglePhotos || [];
        delete req.session.selectedGooglePhotos;
        return selected;
      })(),
      isResume: history.isResume // ← add this line
    });
  } catch (err) {
    console.error('編集画面エラー:', err);
    req.flash('error', '編集画面の表示に失敗しました');
    res.redirect('/history/list');
  }
});

// myhistory編集の保存処理

// 編集保存
router.post('/edit/:id', isLoggedIn, upload().array('photos', 10), async (req, res) => {
    try {
        const { categoryId, from_date, end_date, url, content, share = true, existingPhotos = [], deletePhotos = [] } = req.body;
        const history = await History.findById(req.params.id);
        if (!history) {
            req.flash('error', 'myhistoryが見つかりません');
            return res.redirect('/history/list');
        }

        const category = await HistoryCategory.findById(categoryId);
        if (!category) {
            req.flash('error', 'カテゴリーが見つかりません');
            return res.redirect('/history/list');
        }

        const data = {};
        for (const key in req.body) {
            if (key.startsWith('data_')) {
                const index = key.substring(5);
                const fieldName = category.fields[parseInt(index)]?.name;
                if (fieldName) {
                    data[fieldName] = req.body[key];
                }
            }
        }

        // 既存写真と削除対象を配列として正しく処理
        let existing = [];
        let toDelete = [];

        if (Array.isArray(req.body['existingPhotos'])) {
          existing = req.body['existingPhotos'];
        } else if (req.body['existingPhotos']) {
          existing = [req.body['existingPhotos']];
        }

        if (Array.isArray(req.body['deletePhotos'])) {
          toDelete = req.body['deletePhotos'];
        } else if (req.body['deletePhotos']) {
          toDelete = [req.body['deletePhotos']];
        }

        // 削除写真をCloudinaryから削除（Cloudinaryのみ）
        if (cloudinary?.uploader) {
          for (const delUrl of toDelete) {
            const target = history.photos.find(p => p.url === delUrl && p.source === 'cloudinary');
            if (target) {
              const publicIdMatch = delUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.(jpg|jpeg|png|gif|webp)$/);
              if (publicIdMatch) {
                const publicId = publicIdMatch[1];
                await cloudinary.uploader.destroy(publicId).catch(err => {
                  console.warn(`Cloudinary削除失敗: ${publicId}`, err);
                });
              }
            }
          }
        }

        // 既存写真から削除対象を除外（型を揃えて比較）
        const keptPhotos = history.photos.filter(p =>
          existing.includes(String(p.url)) && !toDelete.includes(String(p.url))
        );

        const newPhotos = req.files?.map(file => ({
          url: file.path,
          source: 'cloudinary'
        })) || [];

        const googlePhotos = (
          Array.isArray(req.body.selectedGooglePhotos)
            ? req.body.selectedGooglePhotos
            : [req.body.selectedGooglePhotos]
        )
          .filter(url => !!url && !toDelete.includes(String(url)))
          .map(url => ({
            url,
            source: 'google'
          }));

        const updatedPhotos = [...keptPhotos, ...newPhotos, ...googlePhotos];


        await History.findByIdAndUpdate(req.params.id, {
            category: categoryId,
            data,
            from_date: from_date || null,
            end_date: end_date || null,
            url,
            content,
            isActive: req.body.isActive === 'true',
            isResume: req.body.isResume === 'true', // ← add this line
            share: share === 'on' || share === true,
            update_date: new Date(),
            photos: updatedPhotos
        });

        req.flash('success', 'myhistoryを更新しました');
        res.redirect('/history/list');
    } catch (err) {
        console.error('myhistory更新エラー:', err);
        req.flash('error', 'myhistoryの更新に失敗しました');
        res.redirect('/history/list');
    }
});

// myhistory削除処理
router.delete('/delete/:id', isLoggedIn, async (req, res) => {
  try {
    const history = await History.findById(req.params.id);

    if (!history || !history.photos || history.photos.length === 0) {
      // 削除対象の履歴が存在しない、または関連写真がない場合はそのまま削除
      await History.findByIdAndDelete(req.params.id);
      req.flash('success', 'myhistoryを削除しました');
      return res.redirect('/history/list');
    }

    // Cloudinaryから画像を削除
    if (cloudinary?.uploader) {
      for (const photo of history.photos) {
        if (photo.source === 'cloudinary') {
          const publicIdMatch = photo.url.match(/\/upload\/(?:v\d+\/)?(.+)\.(jpg|jpeg|png|gif|webp)$/);
          if (publicIdMatch) {
            const publicId = publicIdMatch[1];
            await cloudinary.uploader.destroy(publicId).catch(err => {
              console.warn(`Cloudinary削除失敗: ${publicId}`, err);
            });
          }
        }
      }
    }

    // データベースから履歴を削除
    await History.findByIdAndDelete(req.params.id);
    req.flash('success', 'myhistoryと関連画像を削除しました');
  } catch (err) {
    console.error('myhistoryと関連画像の削除エラー:', err);
    req.flash('error', 'myhistoryと関連画像の削除に失敗しました');
  }
  res.redirect('/history/list');
});

// 全ユーザー共有カテゴリー表示ページ
// 共有カテゴリー一覧ページ
router.get('/categories/shared', isLoggedIn, async (req, res) => {
  try {
    const sharedCategories = await HistoryCategory.find({ share: true }).populate('user');
    res.render('allaboutme/sharedCategories', {
      categories: sharedCategories
    });
  } catch (err) {
    console.error('❌ 共有カテゴリー取得エラー:', err);
    req.flash('error', '共有カテゴリーの表示に失敗しました');
    res.redirect('/history/categories');
  }
});

// 共有カテゴリーを自分のカテゴリーに取り込む
router.post('/categories/import/:id', isLoggedIn, async (req, res) => {
  try {
    const original = await HistoryCategory.findById(req.params.id);
    if (!original || !original.share) {
      req.flash('error', '取り込めるカテゴリーが見つかりません');
      return res.redirect('/history/categories/shared');
    }

    await HistoryCategory.create({
      name: `${original.name} (copy)`, // ← ここを修正
      fields: original.fields,
      color: original.color || '#000000',
      user: req.user._id,
      entry_date: new Date(),
      update_date: new Date(),
      share: false,
      isActive: true
    });

    req.flash('success', 'カテゴリーを取り込みました');
  } catch (err) {
    console.error('カテゴリー取り込みエラー:', err);
    req.flash('error', 'カテゴリーの取り込みに失敗しました');
  }
  res.redirect('/history/categories');
});

module.exports = router;
