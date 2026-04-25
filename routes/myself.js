const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { isLoggedIn } = require('../middleware');

const Wantolist = require('../models/wantolist');
const Eventcal = require('../models/eventcal');
const History = require('../models/history');

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

    const now = new Date();
    const reportYear = now.getFullYear();
    const reportMonth = now.getMonth() + 1;
    const reportStart = new Date(reportYear, reportMonth - 2, 1);
    const reportEnd = new Date(reportYear, reportMonth - 1, 0, 23, 59, 59, 999);
    const reportLabelMonth = reportMonth === 1 ? 12 : reportMonth - 1;
    const reportLabelYear = reportMonth === 1 ? reportYear - 1 : reportYear;

    const reportNewItems = await Wantolist.find({
      user: req.user._id,
      group: objectId,
      entry_date: { $gte: reportStart, $lte: reportEnd }
    }).sort({ entry_date: -1 }).limit(5);

    const reportCompletedItems = await Wantolist.find({
      user: req.user._id,
      group: objectId,
      update_date: { $gte: reportStart, $lte: reportEnd },
      status: { $in: ['実現・解決', '破棄'] }
    }).sort({ update_date: -1 }).limit(5);

    const recentHistories = await History.find({
      user: req.user._id
    })
      .populate('category')
      .sort({ entry_date: -1 })
      .limit(3);

    res.render('myself/top', {
      wantolistItems,
      diaryEntries,
      reportYear: reportLabelYear,
      reportMonth: reportLabelMonth,
      reportNewItems,
      reportCompletedItems,
      recentHistories
    });
  } catch (error) {
    console.error('Myselfトップ取得エラー:', error);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

module.exports = router;
