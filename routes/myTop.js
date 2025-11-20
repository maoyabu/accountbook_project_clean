const express = require('express');
const router = express.Router();
const Finance = require('../models/finance');
const mongoose = require('mongoose');
const FinanceUser = require('../models/users');
const Asset = require('../models/assets');
const Info = require('../models/info');
const axios = require('axios');
const cheerio = require('cheerio');
const GChat = require('../models/gChat');
const GChatMessage = require('../models/gChatMessage');

// 必要なモジュール
const { isLoggedIn } = require('../middleware');


//myTop　の表示
router.get('/top', isLoggedIn, async (req,res)=> {
    try {
      const activeGroupId = req.session.activeGroupId;
      if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/login');
      }
  
      const objectId = typeof activeGroupId === 'string'
        ? new mongoose.Types.ObjectId(activeGroupId)
        : activeGroupId;
  
      const finances = await Finance.find({ group: objectId })
        .populate('user')
        .sort({ entry_date: -1 })
        .limit(20);
  
      const currentUser = await FinanceUser.findById(req.user._id).populate('groups');
      const count = (await Finance.find({ group: objectId })).length;
  
      // ✅ 月間集計のための期間を取得
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
  
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 1);
  
      const thisMonthFinances = await Finance.find({
        group: objectId,
        date: { $gte: start, $lt: end }
      });
  
      // ✅ 集計
      let totalIncome = 0, totalExpense = 0, totalSaving = 0;
      for (let f of thisMonthFinances) {
        if (f.cf === '収入') totalIncome += f.amount;
        else if (f.cf === '貯蓄') totalSaving += f.amount;
        else if (f.cf === '支出' || f.cf === '控除') totalExpense += f.amount;
      }
  
      const balance = totalIncome - totalExpense - totalSaving;

    // --- ユーティリティ関数追加 ---
      async function getExchangeRate(code) {
        if (code === '$') {
          const url = 'https://www.nikkei.com/markets/worldidx/chart/usdjpy/';
          try {
            const response = await axios.get(url);
            const html = response.data;
            const $ = cheerio.load(html);
            const rateText = $('span.m-trend_economic_table_value.a-tar').first().text().replace(/,/g, '');
            const rate = parseFloat(rateText);
            return !isNaN(rate) ? rate : 150;
          } catch (err) {
            console.error('為替レート取得エラー（Nikkei）:', err.message);
            return 150;
          }
        }
        return 1;
      }

      async function getStockPriceFromNikkei(stockCode) {
        const url = `https://www.nikkei.com/nkd/company/history/dprice/?scode=${stockCode}&ba=1`;
        try {
          const response = await axios.get(url);
          const html = response.data;
          const $ = cheerio.load(html);
          const priceText = $('dd.m-stockPriceElm_value.now').first().text().replace(/[,円\s]/g, '');
          const price = parseFloat(priceText);
          return !isNaN(price) ? price : 1;
        } catch (err) {
          console.error(`株価取得エラー（日経, ${stockCode}）:`, err.message);
          return 1;
        }
      }

      // 資産情報の取得
      const assets = await Asset.find({ group: objectId });

      let totalYen = 0;
      const totalByCf = {
        '金融資産': 0,
        '実物資産': 0,
        '無形資産': 0,
        '負債': 0
      };

      for (let asset of assets) {
        let amount = Number(asset.amount) || 0;
        const cf = asset.asset_cf?.trim();
        const unit = asset.monetary_unit?.trim();
        const code = asset.code?.trim();

        if (unit === '$') {
          const rate = await getExchangeRate('$');
          amount *= rate;
        } else if (unit === '数量' && code) {
          const price = await getStockPriceFromNikkei(code);
          amount *= price;
        }

        if (totalByCf.hasOwnProperty(cf)) {
            totalByCf[cf] += Math.round(amount);
        }

        totalYen += Math.round(amount);
        }
  
    // Wantolist（最大5件）
        const Wantolist = require('../models/wantolist');
        const wantolistItems = await Wantolist.find({
        status: '継続中',
        user: req.user._id,
        group: objectId
        })
        .sort({ item: -1 })
        .limit(10);

      // Eventcal_events（日記タイプ、昨日分）
        const Eventcal = require('../models/eventcal');
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const today = new Date(yesterday);
        today.setDate(today.getDate() + 1);

        const yesterdaysDiary = await Eventcal.find({
        user: req.user._id,
        group: objectId,
        date: { $gte: yesterday, $lt: today }
      });

      // お知らせ(Info)を取得
      const nowDate = new Date();
      const infos = await Info.find({
        from_date: { $lte: nowDate },
        end_date: { $gte: nowDate },
        $or: [
          { pub_target: 'all' },
          { pub_target: objectId.toString() }
        ]
      }, {
        info_title: 1,
        info_content: 1,
        app_url: 1,
        guide_url: 1
      }).sort({ from_date: -1 });

      // --- 追加: 問い合わせに管理者返信があるかチェック ---
      const Inquiry = require('../models/inquiry');
      const inquiries = await Inquiry.find({ user: req.user._id });

      // 問い合わせに未読の管理者メッセージがあるかチェック（最後のメッセージが管理者かつ未読かを確認）
      const hasUnreadSupportReply = inquiries.some(inquiry => {
        const messages = inquiry.messages || [];
        const sortedMessages = messages.sort((a, b) => new Date(b.entry_date) - new Date(a.entry_date));
        const lastMessage = sortedMessages[0];
        return lastMessage && lastMessage.isAdmin && !lastMessage.isRead;
      });



      // --- 追加: 未読チャットの取得 ---
      const allChats = await GChat.find({ group: objectId });
      const unreadChats = [];
      for (const chat of allChats) {
        const lastMessage = await GChatMessage.findOne({ chat: chat._id }).sort({ createdAt: -1 });
        if (lastMessage && !lastMessage.readBy.includes(req.user._id)) {
          unreadChats.push(chat);
        }
      }

      // --- 追加: リレーション申請のお知らせ ---
      const Relation = require('../models/relation');
      const pendingRelations = await Relation.find({
        relationUserId: req.user._id,
        status: 'pending'
      });

      res.render('common/myTop', {
        finances,
        count,
        currentUser,
        page: 'list',
        totalIncome,
        totalExpense,
        totalSaving,
        balance,
        totalYen,
        totalByCf,
        wantolistItems,
        yesterdaysDiary,
        infos,
        hasUnreadSupportReply,
        unreadChats,
        pendingRelations,
      });
  
    } catch (error) {
      console.error('一覧取得エラー:', error);
      res.status(500).send("サーバーエラーが発生しました");
    }
  });

  module.exports = router;