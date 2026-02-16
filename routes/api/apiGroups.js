// routes/api/apiGroups.js
const express = require('express');
const router = express.Router();
const Group = require('../../models/groups');
const FinanceUser = require('../../models/users'); // 念のため参照（未使用でもOK）

// 共通ログ
router.use((req, res, next) => {
  console.log('[api/groups]', req.method, req.originalUrl, 'Cookie:', req.headers.cookie || '(none)');
  next();
});

// 認証チェック（セッション前提）
function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

router.use(requireLogin);

/**
 * GET /api/groups
 * ログインユーザーの所属グループ一覧を返す
 */
router.get('/', async (req, res, next) => {
  try {
    // User の groups は ObjectId 配列
    const user = req.user;
    const groupIds = Array.isArray(user.groups) ? user.groups : [];

    if (!groupIds.length) {
      return res.json([]); // 所属なし
    }

    const groups = await Group.find({ _id: { $in: groupIds } })
      .select('group_name') // 必要最小限
      .lean();

    // iOS のモデルに合わせて整形
    const result = groups.map(g => ({
      id: String(g._id),
      name: g.group_name || ''
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;