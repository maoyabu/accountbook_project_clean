// routes/api/apiMusic.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../../models/users');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const APPLE_MUSIC_BASE_URL = 'https://api.music.apple.com/v1/me/recent/played/tracks';

async function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload?.sub;
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: '認証に失敗しました' });
  }
}

router.use(requireLogin);

router.get('/recent', async (req, res, next) => {
  try {
    const musicUserToken =
      req.get('Music-User-Token') ||
      req.get('music-user-token') ||
      req.get('X-Music-User-Token');

    if (!musicUserToken) {
      return res.status(400).json({ error: 'missing_token', message: 'Music User Token が必要です' });
    }

    const developerToken =
      process.env.MUSIC_DEVELOPER_TOKEN ||
      process.env.APPLE_MUSIC_DEVELOPER_TOKEN ||
      '';

    if (!developerToken) {
      return res.status(500).json({ error: 'missing_developer_token', message: 'Developer Token が設定されていません' });
    }

    const days = Math.min(Math.max(parseInt(req.query.days || '7', 10), 1), 30);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 100);

    const url = new URL(APPLE_MUSIC_BASE_URL);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('types', 'songs,library-songs');

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        'Music-User-Token': musicUserToken
      }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: 'apple_music_error',
        message: 'Apple Music APIの取得に失敗しました',
        status: response.status,
        body: text
      });
    }

    const json = await response.json();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const items = (json?.data || []).map(item => {
      const attributes = item.attributes || {};
      const artwork = attributes.artwork || {};
      const lastPlayedDate = attributes.lastPlayedDate || attributes.lastPlayedAt || attributes.playedAt || null;
      const artworkUrl = artwork.url
        ? artwork.url.replace('{w}', '120').replace('{h}', '120')
        : null;

      return {
        id: String(item.id || ''),
        title: attributes.name || '',
        subtitle: attributes.artistName || '',
        lastPlayedDate,
        artworkUrl,
        playUrl: attributes.url || null,
        playId: attributes.playParams?.id || null,
        playKind: attributes.playParams?.kind || null
      };
    }).filter(item => {
      if (!item.lastPlayedDate) return true;
      const time = Date.parse(item.lastPlayedDate);
      if (Number.isNaN(time)) return true;
      return time >= cutoff;
    });

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
