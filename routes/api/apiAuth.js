const express = require('express');
const router = express.Router();
const passport = require('passport');
const jwt = require('jsonwebtoken');
const FinanceUser = require('../../models/users');
const crypto = require('crypto');
const { sendMail } = require('../../Utils/mailer');

// ルーター配下共通の一時ログ
router.use((req, res, next) => {
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ユーザーを JSON に整形（EJS 用の巨大なオブジェクトをそのまま返さない）
function toUserJSON(user) {
      return {
        id: String(user._id),
        username: user.username,
        email: user.email,
        displayname: user.displayname || null,
        avatar: user.avatar || null,
        isAdmin: Boolean(user.isAdmin),
        // 必要に応じて他のフィールド
      };
}

function issueToken(user) {
  return jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: '14d' });
}

// サインアップ
router.post('/signup', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'missing_fields', message: 'username, email, password は必須です' });
    }

    // 既存ユーザー重複チェック
    const exists = await FinanceUser.findOne({ $or: [{ username }, { email }] });
    if (exists) {
      return res.status(409).json({ error: 'conflict', message: '同じ username または email のユーザーが既に存在します' });
    }

    // passport-local-mongoose の register を使って作成
    const user = new FinanceUser({ username, email });
    await FinanceUser.register(user, password);

    // セッションログイン（JWT を使うならここは不要）
    req.login(user, (err) => {
      if (err) return next(err);

      return res.json({
        token: issueToken(user),
        user: toUserJSON(user),
        userId: String(user._id)
      });
    });
  } catch (err) {
    return next(err);
  }
});

// ログイン
router.post('/login', async (req, res, next) => {
  try {
    if (!req.body?.username && req.body?.email) {
      const lookup = await FinanceUser.findOne({ email: req.body.email }).select('username');
      if (lookup?.username) {
        req.body.username = lookup.username;
      }
    }
  } catch (err) {
    return next(err);
  }

  passport.authenticate('local', async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: info?.message || 'ユーザー名またはパスワードが違います' });
    }
    if (user.unsubscribe_date || (user.services && user.services.finance === false)) {
      return res.status(403).json({ error: 'unsubscribed', message: '退会済みのためログインできません' });
    }

    req.login(user, async (err) => {
      if (err) return next(err);

      try {
        // ここで DB から displayname / avatar を含めて再取得する
        const fresh = await FinanceUser.findById(user._id)
          .select('username email displayname avatar isAdmin'); // 必要なフィールドを明示
        const payload = {
          token: issueToken(fresh || user),
          user: toUserJSON(fresh || user),
          userId: String((fresh || user)._id)
        };
        return res.json(payload);
      } catch (dbErr) {
        return next(dbErr);
      }
    });
  })(req, res, next);
});

// パスワード忘れ（API）
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'missing_fields', message: 'email は必須です' });
    }

    const user = await FinanceUser.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'このメールアドレスはまだ、登録されていません' });
    }

    const token = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1時間有効
    await user.save();

    const baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset/${token}`;

    await sendMail({
      to: user.email,
      subject: 'パスワードリセット',
      templateName: 'passwordReset',
      templateData: {
        username: user.username,
        resetUrl
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// パスワードリセット（API）
router.post('/reset/:token', async (req, res, next) => {
  try {
    const { password, confirm } = req.body || {};
    if (!password || !confirm) {
      return res.status(400).json({ error: 'missing_fields', message: 'password, confirm は必須です' });
    }
    if (password !== confirm) {
      return res.status(400).json({ error: 'mismatch', message: 'パスワードが一致しません' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'too_short', message: 'パスワードは8文字以上で入力してください' });
    }

    const user = await FinanceUser.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: 'invalid_token', message: 'パスワードリセットリンクが無効または期限切れです' });
    }

    await user.setPassword(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.update_date = new Date();
    await user.save();

    req.login(user, (err) => {
      if (err) return next(err);
      return res.json({
        token: issueToken(user),
        user: toUserJSON(user),
        userId: String(user._id)
      });
    });
  } catch (err) {
    next(err);
  }
});

// ログアウト（必要なら）
router.post('/logout', (req, res) => {
  req.logout(() => {
    req.session?.destroy(() => {
      res.json({ ok: true });
    });
  });
});

module.exports = router;
