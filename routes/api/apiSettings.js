// routes/api/apiSettings.js
const express = require('express');
const router = express.Router();
const FinanceUser = require('../../models/users');
const Group = require('../../models/groups');
const multer = require('multer');
const { getStorage } = require('../../cloudinary');

// 共通ログ
router.use((req, res, next) => {
  next();
});

// 認証チェック（セッション前提）
function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

router.use(requireLogin);

const upload = multer({ storage: getStorage() });

// GET /api/settings/profile
router.get('/profile', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id)
      .select('username displayname email birth_date entry_date update_date avatar blood rh sex isAdmin groups unsubscribe_date')
      .populate({
        path: 'groups',
        select: 'group_name createdBy invitedUsers'
      })
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const email = user.email || '';
    const groups = (user.groups || []).map(g => {
      const isCreator = String(g.createdBy) === String(user._id);
      const isAdmin = isCreator || (g.invitedUsers || []).includes(email);
      return {
        id: String(g._id),
        name: g.group_name || '',
        role: isAdmin ? '管理者' : 'ユーザー'
      };
    });

    res.json({
      user: {
        id: String(user._id),
        username: user.username,
        displayname: user.displayname || '',
        email: user.email || '',
        birth_date: user.birth_date || null,
        entry_date: user.entry_date || null,
        update_date: user.update_date || null,
        avatar: user.avatar || null,
        blood: user.blood || '',
        rh: user.rh || '',
        sex: user.sex || '',
        isAdmin: Boolean(user.isAdmin),
        unsubscribe_date: user.unsubscribe_date || null
      },
      groups
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings/profile
router.put('/profile', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const {
      displayname,
      email,
      birth_date,
      blood,
      rh,
      sex
    } = req.body || {};

    if (typeof displayname === 'string') user.displayname = displayname;
    if (typeof email === 'string') user.email = email;
    if (typeof blood === 'string') user.blood = blood;
    if (typeof rh === 'string') user.rh = rh;
    if (typeof sex === 'string') user.sex = sex;

    if (birth_date === null || birth_date === '') {
      user.birth_date = null;
    } else if (birth_date) {
      const parsed = new Date(birth_date);
      if (!isNaN(parsed.getTime())) {
        user.birth_date = parsed;
      }
    }

    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/profile/avatar
router.post('/profile/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    if (req.file) {
      user.avatar = req.file.path;
      user.update_date = new Date();
      await user.save();
    }

    res.json({ ok: true, avatar: user.avatar || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/password
router.post('/password', async (req, res, next) => {
  try {
    const { newPassword, confirmPassword } = req.body || {};
    if (!newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'missing_params', message: 'newPassword, confirmPassword は必須です' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'mismatch', message: 'パスワードが一致しません' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'too_short', message: 'パスワードは8文字以上で入力してください' });
    }

    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    await new Promise((resolve, reject) => {
      user.setPassword(newPassword, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    user.update_date = new Date();
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/unsubscribe
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    user.unsubscribe_date = new Date();
    if (user.services && typeof user.services === 'object') {
      user.services.finance = false;
    }
    user.update_date = new Date();
    await user.save();

    req.logout(() => {
      req.session?.destroy(() => {
        res.json({ ok: true });
      });
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
