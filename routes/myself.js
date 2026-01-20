const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { isLoggedIn } = require('../middleware');

const Wantolist = require('../models/wantolist');
const Eventcal = require('../models/eventcal');

// Myselfトップ
router.get('/top', isLoggedIn, async (req, res) => {
  try {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/login');
    }

    const objectId = typeof activeGroupId === 'string'
      ? new mongoose.Types.ObjectId(activeGroupId)
      : activeGroupId;

    const wantolistItems = await Wantolist.find({
      status: '継続中',
      user: req.user._id,
      group: objectId
    })
      .sort({ item: -1 })
      .limit(5);

    const diaryEntries = await Eventcal.find({
      user: req.user._id,
      group: objectId
    })
      .sort({ date: -1 })
      .limit(5);

    res.render('myself/top', {
      wantolistItems,
      diaryEntries
    });
  } catch (error) {
    console.error('Myselfトップ取得エラー:', error);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

module.exports = router;
