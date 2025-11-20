const express = require('express');
const router = express.Router();
const { isLoggedIn } = require('../middleware');
const FinanceUser = require('../models/users');
const Resume = require('../models/resume');
const User = require('../models/users');
const History = require('../models/history');
const HistoryCategory = require('../models/historyCategory');
const Planner = require('../models/planner');
const { sendMail } = require('../Utils/mailer');
const { format, differenceInYears } = require('date-fns');
const path = require('path');

// Plannerリクエスト画面表示
router.get('/', isLoggedIn, async (req, res) => {
  const resumeUrl = req.query.url || '';
  res.render('planner/request', {
    currentUser: req.user,
    url: resumeUrl
  });
});

//　暮らしアドバイザーになろう！画面表示
router.get('/about', isLoggedIn, async (req, res) => {
  res.render('planner/aboutplanner');
});

//　暮らしアドバイスサービスについての画面表示
router.get('/service', isLoggedIn, async (req, res) => {
  res.render('planner/service');
});

// Planner申請処理
router.post('/request', isLoggedIn, async (req, res) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    const { resumeUrl, message } = req.body;

    if (!resumeUrl || !message || !req.body.resumeChecked) {
      req.flash('error', 'すべての項目を入力してください');
      return res.redirect('/planner/planner');
    }

    // Save the application to the database
    const newPlannerEntry = new Planner({
      user: user._id,
      url: resumeUrl,
      message,
      adopt: '検討中'
    });
    await newPlannerEntry.save();

    const templateData = {
      username: user.displayname || user.username,
      email: user.email,
      resumeUrl,
      message
    };

    await sendMail({
      to: process.env.ADMIN_EMAIL,
      subject: '【Planner申込】ユーザーからの申請があります',
      templateName: 'planner_request',
      templateData
    });

    req.flash('success', '申込みを送信しました。管理者からの連絡をお待ちください。');
    res.redirect('/myTop/top');
  } catch (err) {
    console.error(err);
    req.flash('error', '申請送信中にエラーが発生しました');
    res.redirect('/planner');
  }
});

// Planner職務履歴書画面の表示（planner.ejs）
router.get('/planner', isLoggedIn, async (req, res) => {
  const userId = req.user._id;
  // Resume・User
  const resume = await Resume.findOne({ user: userId });
  const user = await User.findById(userId).populate('groups');

  // プランナー経歴カテゴリの有無チェック
  let hasPlannerCategory = false;
  try {
    const plannerCategory = await HistoryCategory.findOne({
      user: userId,
      name: '経歴【Planner】'
    });
    if (plannerCategory) {
      hasPlannerCategory = true;
    }
  } catch (e) {
    hasPlannerCategory = false;
  }

  const currentUser = {
    ...(user ? user.toObject() : {}),
    hasPlannerCategory
  };

  // 職歴カテゴリID取得
  const resumeCareerCategory = await HistoryCategory.findOne({ name: '経歴【Planner】' });
  const resumeCareerCategoryId = resumeCareerCategory?._id;
  // 職歴エントリ取得
  let careerEntries = [];
  if (resumeCareerCategoryId) {
    const careerEntriesRaw = await History.find({
      user: userId,
      isResume: true,
      category: resumeCareerCategoryId
    }).sort({ from_date: 1 });

    // 年齢算出関数
    function calculateAgeRange(birthDate, fromDate, endDate) {
      if (!birthDate || !fromDate || !endDate) return '';
      const fromAge = differenceInYears(fromDate, birthDate);
      const toAge = differenceInYears(endDate, birthDate);
      return `${fromAge}歳〜${toAge}歳`;
    }

    careerEntries = careerEntriesRaw.map(entry => ({
      _id: entry._id,
      company: entry.data?.['職場'] || '',
      from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
      end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
      age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
      summary: entry.data?.['仕事内容'] || '',
      details: entry.data?.['付加情報・アピールポイント'] || ''
    }));
  }

  // 既にphotoBase64が存在する場合は優先的に利用
  let photoBase64 = '';
  if (resume && resume.photoBase64) {
    photoBase64 = resume.photoBase64;
  } else if (resume && resume.photo_url) {
    // ない場合はCloudinary画像をBase64変換（表示のみ。保存はしない）
    try {
      const axios = require('axios');
      const response = await axios.get(resume.photo_url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const mimeType = response.headers['content-type'];
      photoBase64 = `data:${mimeType};base64,${Buffer.from(response.data).toString('base64')}`;
    } catch (err) {
      photoBase64 = '';
    }
  }

  res.render('planner/planner', {
    layout: 'layouts/boilerplate',
    resume,
    user,
    careerEntries,
    photoBase64,
    currentUser
  });
});

// Planner職務履歴書（印刷用）のルート
router.get('/print', isLoggedIn, async (req, res) => {
  const userId = req.user._id;
  const resume = await Resume.findOne({ user: userId });
  const user = await User.findById(userId);

  const resumeCareerCategory = await HistoryCategory.findOne({ name: '経歴【Planner】' });
  const resumeCareerCategoryId = resumeCareerCategory?._id;

  let careerEntries = [];
  if (resumeCareerCategoryId) {
    const careerEntriesRaw = await History.find({
      user: userId,
      category: resumeCareerCategoryId
    }).sort({ from_date: 1 });

    function calculateAgeRange(birthDate, fromDate, endDate) {
      if (!birthDate || !fromDate || !endDate) return '';
      const fromAge = differenceInYears(fromDate, birthDate);
      const toAge = differenceInYears(endDate, birthDate);
      return `${fromAge}歳〜${toAge}歳`;
    }

    careerEntries = careerEntriesRaw.map(entry => ({
      _id: entry._id,
      company: entry.data?.['職場'] || '',
      from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
      end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
      age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
      summary: entry.data?.['仕事内容'] || '',
      details: entry.data?.['付加情報・アピールポイント'] || ''
    }));
  }

  res.render('planner/print', {
    layout: 'layouts/print',
    resume,
    user,
    careerEntries
  });
});

// Planner職務履歴書の公開用URLを作成
router.post('/publish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, message: '履歴書が見つかりません' });
    }

    // 公開フラグを true に設定
    resume.ispPublished = true;
    await resume.save();

    res.json({
      success: true,
      message: '公開用URLを作成しました',
      url: `/planner/public/plannercv/${resume._id}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'エラーが発生しました' });
  }
});

// 公開ページの停止ルート
router.post('/unpublish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { ispPublished: false },
      { new: true }
    );
    res.redirect('/planner/planner');
  } catch (err) {
    console.error(err);
    req.flash('error', '公開停止に失敗しました');
    res.redirect('/planner/planner');
  }
});

// Planner職務履歴書 公開ページの表示
router.get('/public/plannercv/:id', async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, ispPublished: true });
    if (!resume) {
      return res.status(404).send('公開されていません');
    }

    const user = await User.findById(resume.user);
    const resumeCareerCategory = await HistoryCategory.findOne({ name: '経歴【Planner】' });
    const resumeCareerCategoryId = resumeCareerCategory?._id;

    let careerEntries = [];
    if (resumeCareerCategoryId) {
      const careerEntriesRaw = await History.find({
        user: resume.user,
        category: resumeCareerCategoryId
      }).sort({ from_date: 1 });

      function calculateAgeRange(birthDate, fromDate, endDate) {
        if (!birthDate || !fromDate || !endDate) return '';
        const fromAge = differenceInYears(fromDate, birthDate);
        const toAge = differenceInYears(endDate, birthDate);
        return `${fromAge}歳〜${toAge}歳`;
      }

      careerEntries = careerEntriesRaw.map(entry => ({
        _id: entry._id,
        company: entry.data?.['職場'] || '',
        from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
        end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
        age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
        summary: entry.data?.['仕事内容'] || '',
        details: entry.data?.['付加情報・アピールポイント'] || ''
      }));
    }

    res.render('planner/plannercv', {
      layout: 'layouts/print',
      resume,
      user,
      careerEntries
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('エラーが発生しました');
  }
});

//　暮らしアドバイザー　一覧画面表示
router.get('/list', isLoggedIn, async (req, res) => {
  res.render('planner/planner_list');
});

module.exports = router;