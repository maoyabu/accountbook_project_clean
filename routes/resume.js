const { format, differenceInYears } = require('date-fns');
const express = require('express');
const router = express.Router();
const Resume = require('../models/resume');
const { isLoggedIn } = require('../middleware');
const FinanceUser = require('../models/users');
const History = require('../models/history');
const HistoryCategory = require('../models/historyCategory');
const QRCode = require('qrcode');
// 履歴書表示 myresume
const Category = require('../models/historyCategory'); // 新しいカテゴリモデル
const User = require('../models/users'); // 既存

// 必要なモジュール
const multer = require('multer');
const { getStorage } = require('../cloudinary'); // cloudinary config
const upload = () => multer({ storage: getStorage() });

// 履歴書の表示
router.get('/', isLoggedIn, async (req, res) => {
  const resume = await Resume.findOne({ user: req.user._id });
  res.render('resume/resume', { resume });
});

// 新規作成（resumeが存在しないときのルート）
router.get('/create', isLoggedIn, async (req, res) => {
  let existing = await Resume.findOne({ user: req.user._id });
  // Check for プランナー経歴カテゴリ
  const plannerCategory = await HistoryCategory.findOne({
    user: req.user._id,
    name: '経歴【Planner】'
  });
  const currentUser = {
    ...(req.user.toObject ? req.user.toObject() : req.user),
    hasPlannerCategory: !!plannerCategory
  };
  if (existing) {
    // If redirect, ensure /edit/:id uses currentUser as well
    return res.redirect(`/resume/edit/${existing._id}`);
  }

  const newResume = new Resume({ user: req.user._id });
  await newResume.save();
  res.redirect(`/resume/edit/${newResume._id}`);
});

// 履歴書設定の登録
router.post('/create', isLoggedIn, upload().single('photo'), async (req, res) => {
  const {
    summary,
    skills,
    experience,
    self_promotion,
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  } = req.body;
  const photo_url = req.file ? req.file.path : '';
  const resume = new Resume({
    user: req.user._id,
    summary,
    skills,
    experience,
    self_promotion,
    photo_url,
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  });
  await resume.save();
  req.flash('success', '履歴書を登録しました');
  res.redirect('/allaboutme/myresume');
});

// 保存（明示的な保存用ルート）
router.post('/save', isLoggedIn, upload().single('photo'), async (req, res) => {
  const {
    summary,
    skills,
    experience,
    self_promotion,
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  } = req.body;
  const updateData = {
    summary,
    skills,
    experience,
    self_promotion,
    update_date: new Date(),
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  };
  if (req.file) {
    updateData.photo_url = req.file.path;
  }
  await Resume.findOneAndUpdate(
    { user: req.user._id },
    updateData,
    { new: true, upsert: true }
  );
  req.flash('success', '履歴書を保存しました');
  res.redirect('/resume/myresume');
});

// 編集画面の表示
router.get('/edit/:id', isLoggedIn, async (req, res) => {
  const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
  if (!resume) {
    req.flash('error', '履歴書が見つかりません');
    return res.redirect('/profile');
  }
  // Check for プランナー経歴カテゴリ
  const plannerCategory = await HistoryCategory.findOne({
    user: req.user._id,
    name: '経歴【Planner】'
  });
  const currentUser = {
    ...(req.user.toObject ? req.user.toObject() : req.user),
    hasPlannerCategory: !!plannerCategory
  };
  res.render('resume/resume', { resume, currentUser });
});

// 編集保存処理
router.post('/edit/:id', isLoggedIn, upload().single('photo'), async (req, res) => {
  const {
    summary,
    skills,
    experience,
    self_promotion,
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  } = req.body;
  const updateData = {
    summary,
    skills,
    experience,
    self_promotion,
    update_date: new Date(),
    last_name,
    first_name,
    last_name_kana,
    first_name_kana,
    zip,
    prefecture,
    city,
    address_detail,
    home_phone,
    mobile_phone
  };
  if (req.file) {
    updateData.photo_url = req.file.path;
  }

  await Resume.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    updateData,
    { new: true }
  );
  req.flash('success', '履歴書を更新しました');
  res.redirect('/allaboutme/myresume');
});

// 職務歴書の表示　mycv
router.get('/mycv', isLoggedIn, async (req, res) => {
  // Find resume for the current user
  const resume = await Resume.findOne({ user: req.user._id });
  const userId = req.user._id;
  const user = await User.findById(userId).populate('groups');
  // Fetch histories for resume (職務履歴・会社【履歴書対応】)
  const historyEntries = await History.find({
    user: req.user._id,
    isResume: true
  }).populate('category');

  const filteredEntries = historyEntries
    .filter(entry => entry.category?.name?.includes('職務履歴・会社【履歴書対応】'))
    .map(entry => ({
      ...entry._doc,
      company: entry.data?.['会社名'] || '',
      department: entry.data?.['部署名'] || '',
      position: entry.data?.['役職'] || '',
      summary: entry.data?.['経歴（簡潔）'] || '',
      details: entry.data?.['経歴付加情報・アピールポイント'] || ''
    }));

  // --- Format from_date, end_date, and age ---
  const formatYM = (date) => {
    if (!date) return '';
    return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
  };

  const calcAge = (birth, date) => {
    let age = date.getFullYear() - birth.getFullYear();
    if (
      date.getMonth() < birth.getMonth() ||
      (date.getMonth() === birth.getMonth() && date.getDate() < birth.getDate())
    ) {
      age--;
    }
    return age;
  };

  // Use req.user for currentUser
  const currentUser2 = req.user;
  const birthDate = currentUser2.birth_date ? new Date(currentUser2.birth_date) : null;

  const historyEntriesFormatted = filteredEntries.map(entry => {
    const from = entry.from_date ? new Date(entry.from_date) : null;
    const end = entry.end_date ? new Date(entry.end_date) : null;
    const fromStr = from ? formatYM(from) : '';
    const endStr = end ? formatYM(end) : '';
    const ageRange = (birthDate && from && end)
      ? `${calcAge(birthDate, from)}歳 - ${calcAge(birthDate, end)}歳`
      : '';
    return {
      ...entry,
      from_date_str: fromStr,
      end_date_str: endStr,
      age_range: ageRange
    };
  });

  // from_date降順でソート
  const sortedEntries = historyEntriesFormatted.sort((a, b) => {
    return b.from_date - a.from_date;
  });

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
  // currentUserを拡張して渡す（EJSで可読性のため）
  const currentUser = {
    ...(user ? user.toObject() : {}),
    hasPlannerCategory
  };

  res.render('allaboutme/mycv', {
    page: 'mycv',
    resume,
    historyEntries: sortedEntries,
    currentUser
  });
});

// /myresume (改良: 教育・職歴をisResume: trueでまとめて取得し、filter/mapで分割)
router.get('/myresume', isLoggedIn, async (req, res) => {
  const userId = req.user._id;
  // Resume・User
  const resume = await Resume.findOne({ user: userId });
  const user = await User.findById(userId).populate('groups');

  // 教育カテゴリID取得
  const resumeEducationCategory = await HistoryCategory.findOne({ name: '学歴【履歴書対応】' });
  const resumeEducationCategoryId = resumeEducationCategory?._id;
  // 職歴カテゴリID取得
  const resumeCareerCategory = await HistoryCategory.findOne({ name: '職務履歴・会社【履歴書対応】' });
  const resumeCareerCategoryId = resumeCareerCategory?._id;

  // 学歴エントリ取得
  let educationEntries = [];
  if (resumeEducationCategoryId) {
    const educationEntriesRaw = await History.find({
      user: userId,
      isResume: true,
      category: resumeEducationCategoryId
    }).sort({ from_date: 1 });
    educationEntries = educationEntriesRaw.map(entry => ({
      _id: entry._id,
      from_date: entry.from_date,
      from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
      end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
      school_type: entry.data?.['学校区分'] || '',
      school_name: entry.data?.['学校名'] || '',
      detail: entry.data?.['学校で学んだ事'] || ''
    }));
  }

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
      company: entry.data?.['会社名'] || '',
      department: entry.data?.['部署名'] || '',
      position: entry.data?.['役職'] || '',
      from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
      end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
      age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
      summary: entry.data?.['経歴（簡潔）'] || '',
      details: entry.data?.['経歴付加情報・アピールポイント'] || ''
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
  // currentUserを拡張して渡す（EJSで可読性のため）
  const currentUser = {
    ...(user ? user.toObject() : {}),
    hasPlannerCategory
  };

  res.render('allaboutme/myresume', {
    layout: 'layouts/boilerplate',
    resume,
    user,
    educationEntries,
    careerEntries,
    photoBase64,
    currentUser
  });
});

// 日付を「年/月」形式に整形
function formatDateYM(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}

// 履歴書HTMLプレビュー
router.get('/resume/view/:id', isLoggedIn, async (req, res) => {
  try {
    const resumeId = req.params.id;
    const resume = await Resume.findById(resumeId);
    if (!resume) {
      return res.status(404).send('履歴書が見つかりません');
    }
    const user = await FinanceUser.findById(resume.user);
    const resumeEducationCategory = await HistoryCategory.findOne({ name: '学歴【履歴書対応】' });
    const resumeCareerCategory = await HistoryCategory.findOne({ name: '職務履歴・会社【履歴書対応】' });

    let educationEntries = [];
    if (resumeEducationCategory?._id) {
      const educationEntriesRaw = await History.find({
        user: user._id,
        isResume: true,
        category: resumeEducationCategory._id
      }).sort({ from_date: 1 });
      educationEntries = educationEntriesRaw.map(entry => ({
        _id: entry._id,
        from_date: entry.from_date,
        from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
        end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
        school_type: entry.data?.['学校区分'] || '',
        school_name: entry.data?.['学校名'] || '',
        detail: entry.data?.['学校で学んだ事'] || ''
      }));
    }

    let careerEntries = [];
    if (resumeCareerCategory?._id) {
      const careerEntriesRaw = await History.find({
        user: user._id,
        isResume: true,
        category: resumeCareerCategory._id
      }).sort({ from_date: 1 });

      function calculateAgeRange(birthDate, fromDate, endDate) {
        if (!birthDate || !fromDate || !endDate) return '';
        const fromAge = differenceInYears(fromDate, birthDate);
        const toAge = differenceInYears(endDate, birthDate);
        return `${fromAge}歳〜${toAge}歳`;
      }

      careerEntries = careerEntriesRaw.map(entry => ({
        _id: entry._id,
        company: entry.data?.['会社名'] || '',
        department: entry.data?.['部署名'] || '',
        position: entry.data?.['役職'] || '',
        from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
        end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
        age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
        summary: entry.data?.['経歴（簡潔）'] || '',
        details: entry.data?.['経歴付加情報・アピールポイント'] || ''
      }));
    }

    // photoBase64優先
    let photoBase64 = '';
    if (resume.photoBase64) {
      photoBase64 = resume.photoBase64;
    } else if (resume.photo_url) {
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

    // QRコード生成
    const publicUrl = `${req.protocol}://${req.get('host')}/resume/public/myresume/${resume._id}`;
    const qrCodeDataUrl = await QRCode.toDataURL(publicUrl);

    if (req.query.format === 'pdf') {
      res.send('PDF出力は現在一時的に無効化されています。');
    } else {
      res.render('allaboutme/myresume_pdf', {
        resume,
        user,
        educationEntries,
        careerEntries,
        photoBase64,
        qrCodeDataUrl
      });
    }
  } catch (err) {
    console.error('履歴書の表示/出力エラー:', err);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

// 職務経歴書プレビュー
router.get('/mycv/view/:id', isLoggedIn, async (req, res) => {
  try {
    const resumeId = req.params.id;
    const format = req.query.format;
    const resume = await Resume.findById(resumeId);
    if (!resume) {
      return res.status(404).send('履歴書が見つかりません');
    }

    const user = await FinanceUser.findById(resume.user);
    const birthDate = user.birth_date ? new Date(user.birth_date) : null;

    const historyEntriesRaw = await History.find({
      user: user._id,
      isResume: true
    }).populate('category');

    const filteredEntries = historyEntriesRaw
      .filter(entry => entry.category?.name?.includes('職務履歴・会社【履歴書対応】'))
      .map(entry => ({
        ...entry._doc,
        company: entry.data?.['会社名'] || '',
        department: entry.data?.['部署名'] || '',
        position: entry.data?.['役職'] || '',
        summary: entry.data?.['経歴（簡潔）'] || '',
        details: entry.data?.['経歴付加情報・アピールポイント'] || ''
      }));

    const formatYM = (date) => {
      if (!date) return '';
      return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    };

    const calcAge = (birth, date) => {
      let age = date.getFullYear() - birth.getFullYear();
      if (
        date.getMonth() < birth.getMonth() ||
        (date.getMonth() === birth.getMonth() && date.getDate() < birth.getDate())
      ) {
        age--;
      }
      return age;
    };

    const formattedEntries = filteredEntries.map(entry => {
      const from = entry.from_date ? new Date(entry.from_date) : null;
      const end = entry.end_date ? new Date(entry.end_date) : null;
      const fromStr = from ? formatYM(from) : '';
      const endStr = end ? formatYM(end) : '';
      const ageRange = (birthDate && from && end)
        ? `${calcAge(birthDate, from)}歳 - ${calcAge(birthDate, end)}歳`
        : '';
      return {
        ...entry,
        from_date_str: fromStr,
        end_date_str: endStr,
        age_range: ageRange
      };
    });

    // --- Add QR code URL for public mycv ---
    const publicUrl = `${req.protocol}://${req.get('host')}/resume/public/mycv/${resumeId}`;
    const qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(publicUrl)}`;

    const sortedEntries = formattedEntries.sort((a, b) => b.from_date - a.from_date);

    // photoBase64優先
    let photoBase64 = '';
    if (resume.photoBase64) {
      photoBase64 = resume.photoBase64;
    } else if (resume.photo_url) {
      try {
        const axios = require('axios');
        const response = await axios.get(resume.photo_url, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const mimeType = response.headers['content-type'];
        photoBase64 = `data:${mimeType};base64,${Buffer.from(response.data).toString('base64')}`;
      } catch (error) {
        photoBase64 = '';
      }
    }

    if (format === 'pdf') {
      res.send('PDF出力は現在一時的に無効化されています。');
    } else {
      res.render('allaboutme/mycv_pdf', {
        resume,
        user,
        historyEntries: formattedEntries,
        qrCodeDataUrl
      });
    }
  } catch (err) {
    console.error('職務履歴書出力エラー:', err);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

// 職務履歴書の公開用URLを作成（mycv専用）
router.post('/mycv/publish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, message: '履歴書が見つかりません' });
    }

    // isPublished を true にして保存
    resume.isPublished = true;
    await resume.save();

    res.json({
      success: true,
      message: '公開用URLを作成しました',
      url: `/public/mycv/${resume._id}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'エラーが発生しました' });
  }
});

// 職務履歴書の公開を停止（mycv専用）
router.post('/mycv/unpublish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, message: '履歴書が見つかりません' });
    }

    resume.isPublished = false;
    await resume.save();

    res.json({ success: true, message: '公開を停止しました' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '公開停止中にエラーが発生しました' });
  }
});

// 公開職務履歴書ページの表示
router.get('/public/mycv/:id', async (req, res) => {
  try {
    const resume = await Resume.findById(req.params.id);
    if (!resume?.isPublished) return res.status(404).render('resume/resume_unpublished');

    const user = await FinanceUser.findById(resume.user);
    const birthDate = user.birth_date ? new Date(user.birth_date) : null;

    const historyEntriesRaw = await History.find({
      user: user._id,
      isResume: true
    }).populate('category');

    const filteredEntries = historyEntriesRaw
      .filter(entry => entry.category?.name?.includes('職務履歴・会社【履歴書対応】'))
      .map(entry => ({
        ...entry._doc,
        company: entry.data?.['会社名'] || '',
        department: entry.data?.['部署名'] || '',
        position: entry.data?.['役職'] || '',
        summary: entry.data?.['経歴（簡潔）'] || '',
        details: entry.data?.['経歴付加情報・アピールポイント'] || ''
      }));

    const formatYM = (date) => {
      if (!date) return '';
      return `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    };

    const calcAge = (birth, date) => {
      let age = date.getFullYear() - birth.getFullYear();
      if (
        date.getMonth() < birth.getMonth() ||
        (date.getMonth() === birth.getMonth() && date.getDate() < birth.getDate())
      ) {
        age--;
      }
      return age;
    };

    const formattedEntries = filteredEntries.map(entry => {
      const from = entry.from_date ? new Date(entry.from_date) : null;
      const end = entry.end_date ? new Date(entry.end_date) : null;
      const fromStr = from ? formatYM(from) : '';
      const endStr = end ? formatYM(end) : '';
      const ageRange = (birthDate && from && end)
        ? `${calcAge(birthDate, from)}歳 - ${calcAge(birthDate, end)}歳`
        : '';
      return {
        ...entry,
        from_date_str: fromStr,
        end_date_str: endStr,
        age_range: ageRange
      };
    });

    const sortedEntries = formattedEntries.sort((a, b) => b.from_date - a.from_date);

    res.render('resume/public_cv', {
      resume,
      user,
      historyEntries: sortedEntries,
      req // ← これを追加
    });
  } catch (err) {
    console.error('公開ページエラー:', err);
    res.status(500).render('error', { message: 'サーバーエラーが発生しました。' });
  }
});

// 履歴書の公開用URLを作成（myresume専用）
router.post('/myresume/publish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, message: '履歴書が見つかりません' });
    }

    resume.isrPublished = true;
    await resume.save();

    res.json({
      success: true,
      message: '公開用URLを作成しました',
      url: `/resume/public/myresume/${resume._id}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'エラーが発生しました' });
  }
});

// 履歴書の公開を停止（myresume専用）
router.post('/myresume/unpublish/:id', isLoggedIn, async (req, res) => {
  try {
    const resume = await Resume.findOne({ _id: req.params.id, user: req.user._id });
    if (!resume) {
      return res.status(404).json({ success: false, message: '履歴書が見つかりません' });
    }

    resume.isrPublished = false;
    await resume.save();

    res.json({ success: true, message: '公開を停止しました' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '公開停止中にエラーが発生しました' });
  }
});

// 公開履歴書ページの表示（myresume専用）
router.get('/public/myresume/:id', async (req, res) => {
  try {
    const resume = await Resume.findById(req.params.id);
    if (!resume?.isrPublished) return res.status(404).render('resume/resume_unpublished');

    const user = await FinanceUser.findById(resume.user);
    if (!user) return res.status(404).render('resume/resume_unpublished');

    // 学歴データの取得
    const educationCategory = await HistoryCategory.findOne({
      name: '学歴【履歴書対応】',
      user: user._id,
      isResume: true
    });

    let educationEntries = [];
    if (educationCategory?._id) {
      const educationRaw = await History.find({
        user: user._id,
        isResume: true,
        category: educationCategory._id
      }).sort({ from_date: 1 });

      educationEntries = educationRaw.map(entry => ({
        _id: entry._id,
        from_date: entry.from_date,
        from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
        end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
        school_type: entry.data?.['学校区分'] || '',
        school_name: entry.data?.['学校名'] || '',
        detail: entry.data?.['学校で学んだ事'] || ''
      }));
    }

    // 職歴データの取得
    const careerCategory = await HistoryCategory.findOne({
      name: '職務履歴・会社【履歴書対応】',
      user: user._id,
      isResume: true
    });

    let careerEntries = [];
    if (careerCategory?._id) {
      const careerRaw = await History.find({
        user: user._id,
        isResume: true,
        category: careerCategory._id
      }).sort({ from_date: 1 });

      function calculateAgeRange(birthDate, fromDate, endDate) {
        if (!birthDate || !fromDate || !endDate) return '';
        const fromAge = differenceInYears(fromDate, birthDate);
        const toAge = differenceInYears(endDate, birthDate);
        return `${fromAge}歳〜${toAge}歳`;
      }

      careerEntries = careerRaw.map(entry => ({
        _id: entry._id,
        company: entry.data?.['会社名'] || '',
        department: entry.data?.['部署名'] || '',
        position: entry.data?.['役職'] || '',
        from_date_str: entry.from_date ? format(entry.from_date, 'yyyy/MM') : '',
        end_date_str: entry.end_date ? format(entry.end_date, 'yyyy/MM') : '',
        age_range: calculateAgeRange(user.birth_date, entry.from_date, entry.end_date),
        summary: entry.data?.['経歴（簡潔）'] || '',
        details: entry.data?.['経歴付加情報・アピールポイント'] || ''
      }));
    }

    let photoBase64 = '';
    if (resume.photoBase64) {
      photoBase64 = resume.photoBase64;
    } else if (resume.photo_url) {
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

    const publicUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const qrCodeDataUrl = await QRCode.toDataURL(publicUrl);

    res.render('allaboutme/myresume_pdf', {
      resume,
      user,
      educationEntries,
      careerEntries,
      photoBase64,
      qrCodeDataUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('エラーが発生しました');
  }
});

module.exports = router;
