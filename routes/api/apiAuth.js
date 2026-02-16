const express = require('express');
const router = express.Router();
const passport = require('passport');
const FinanceUser = require('../../models/users');

// ルーター配下共通の一時ログ
router.use((req, res, next) => {
  console.log('[api/auth]', req.method, req.originalUrl, 'Cookie:', req.headers.cookie || '(none)');
  next();
});

// もし JWT を使うなら jwt ライブラリを利用
// const jwt = require('jsonwebtoken');
// const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

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

      // JWT を返したい場合の例（必要ならコメントアウトを外す）
      // const token = jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: '7d' });

      return res.json({
        token: 'session', // セッションベースの場合のダミー。JWT を使うなら token を上書き
        user: toUserJSON(user)
      });
    });
  } catch (err) {
    return next(err);
  }
});

// ログイン
router.post('/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', message: info?.message || 'ユーザー名またはパスワードが違います' });
    }
    req.login(user, async (err) => {
      if (err) return next(err);

      try {
        // ここで DB から displayname / avatar を含めて再取得する
        const fresh = await FinanceUser.findById(user._id)
          .select('username email displayname avatar isAdmin'); // 必要なフィールドを明示
        const payload = { token: 'session', user: toUserJSON(fresh || user) };
        console.log('[api/auth] login response:', JSON.stringify(payload));
        return res.json(payload);
      } catch (dbErr) {
        return next(dbErr);
      }
    });
  })(req, res, next);
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
