const passport = require('passport');
const FinanceUser = require('../models/users');
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { ensureAuthenticated } = require('../middleware');

const algorithm = 'aes-256-cbc';
const key = crypto.scryptSync(process.env.SECURE_NOTE_SECRET || 'default_secret_key', 'salt', 32);

const Asset = require('../models/assets');

// セキュアノートの取得（復号）ルート
router.post(
  '/:id',
  ensureAuthenticated,
  async (req, res, next) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'パスワードが必要です' });
    }

    try {
      const user = await FinanceUser.findById(req.user._id);
      if (!user) {
        return res.status(403).json({ error: 'ユーザーが見つかりません' });
      }

      // Passport-local-mongoose による認証用に username を明示セット
      req.body.username = user.username;
      req.body.password = password;

      // 認証を明示的に実行（セッションは更新しない）
      passport.authenticate('local', { session: false }, async (err, user, info) => {
        if (err || !user) {
          return res.status(401).json({ error: 'パスワードが正しくありません' });
        }

        try {
          const asset = await Asset.findOne({
            _id: req.params.id,
            group: req.session.activeGroupId
          }).select('+secure_note');
          // console.log(asset);
          if (!asset) {
            return res.status(404).json({ error: '資産が見つかりません' });
          }

          const decryptedNote = asset.decryptSecureNote();
          res.json({ secure_note: decryptedNote });
        } catch (err) {
          console.error('セキュアノート取得エラー:', err.stack || err.message || err);
          res.status(500).json({ error: '取得中にエラーが発生しました' });
        }
      })(req, res, next);
    } catch (err) {
      console.error('認証前処理エラー:', err.stack || err.message || err);
      res.status(500).json({ error: '内部エラーが発生しました' });
    }
  }
);

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  // prepend iv to encrypted string
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
  const parts = encrypted.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted text format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = router;