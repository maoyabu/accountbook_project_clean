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
router.get('/top', isLoggedIn, async (req, res) => {
    const activeService = req.session?.activeService === 'myself' ? 'myself' : 'finance';
    if (!req.session.activeService) {
        req.session.activeService = activeService;
    }
    const redirectUrl = activeService === 'myself' ? '/myself/top' : '/finance/top';
    return res.redirect(redirectUrl);
});

  module.exports = router;
