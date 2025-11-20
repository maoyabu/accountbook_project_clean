// Node.js 側で OAuth2 と Photos Library API を組み込む
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const axios = require('axios');

const BASE_URL = process.env.BASE_URL;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/googlePhotos/callback`
);

// 認可 URL を生成
router.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/photoslibrary'] 
  });
  res.redirect(url);
});

// ✅ 認証後のコールバックルート
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('コードが見つかりません');

  try {
    const { tokens } = await oauth2Client.getToken(code);

    // 明示的に再セット
    oauth2Client.setCredentials(tokens);

    // セッションに保存
    req.session.googleTokens = tokens;

    // ✅ トークンの内容と scope を確認

    res.redirect('/googlePhotos/select');
  } catch (err) {
    res.status(500).send('Google認証に失敗しました');
  }
});

// ✅ /select ルート（start, end の日付でフィルター可能）
router.get('/select', async (req, res) => {
  if (!req.session.googleTokens) {
    req.flash('error', 'Google認証が必要です');
    return res.redirect('/googlePhotos/auth');
  }

  oauth2Client.setCredentials(req.session.googleTokens);

  try {
    const { start, end, albumId } = req.query;
    const filters = {};

    if (start || end) {
      const range = {};
      if (start) {
        const s = new Date(start);
        range.startDate = { year: s.getFullYear(), month: s.getMonth() + 1, day: s.getDate() };
      }
      if (end) {
        const e = new Date(end);
        range.endDate = { year: e.getFullYear(), month: e.getMonth() + 1, day: e.getDate() };
      }
      filters.dateFilter = { ranges: [range] };
    }

    // アルバム取得
    const albumRes = await axios.get(
      'https://photoslibrary.googleapis.com/v1/albums?pageSize=50',
      {
        headers: {
          Authorization: `Bearer ${oauth2Client.credentials.access_token}`
        }
      }
    );
    const albums = albumRes.data.albums || [];

    const body = {
      pageSize: 50,
      ...(Object.keys(filters).length > 0 && { filters }),
      ...(albumId ? { albumId } : {})
    };

    const response = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:search',
        body,
      {

        headers: {
          Authorization: `Bearer ${oauth2Client.credentials.access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const items = response.data.mediaItems || [];
    res.render('photos/select', {
        items,
        startDate: start,
        endDate: end,
        albums,
        albumId 
    });
  } catch (err) {
    req.flash('error', '写真の取得に失敗しました');
    res.redirect('/googlePhotos/select');
  }
});

// 選択完了 POST
router.post('/from-select', (req, res) => {
  const selected = req.body.selectedPhotos || [];
  console.log('📷 選択されたGoogle PhotoのURL一覧:', selected);
  req.session.selectedGooglePhotos = selected;
  console.log('🗂️ セッションに保存された selectedGooglePhotos:', req.session.selectedGooglePhotos);

  const { item, redirect } = req.body;
  console.log('📌 選択された項目 item:', item);
  const redirectPath = redirect === 'batch' ? '/allaboutme/eventcal_batch' : '/allaboutme/eventcal';
  console.log('🔗 リダイレクト先:', `${redirectPath}?fromGooglePhoto=1&item=${encodeURIComponent(item || '')}`);

  res.redirect(`${redirectPath}?fromGooglePhoto=1&item=${encodeURIComponent(item || '')}`);
});


module.exports = router;