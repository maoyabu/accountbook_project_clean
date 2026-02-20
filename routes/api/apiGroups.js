// routes/api/apiGroups.js
const express = require('express');
const router = express.Router();
const Group = require('../../models/groups');
const FinanceUser = require('../../models/users'); // 念のため参照（未使用でもOK）

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

/**
 * POST /api/groups
 * グループ作成（作成者は管理者扱い）
 * body: { name }
 */
router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'missing_params', message: 'name は必須です' });
    }

    const user = await FinanceUser.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'not_found', message: 'ユーザーが見つかりません' });
    }

    const group = await Group.create({
      group_name: name,
      createdBy: user._id,
      members: [user._id],
      invitedUsers: user.email ? [user.email] : []
    });

    // ユーザーの参加グループに追加
    if (!Array.isArray(user.groups)) {
      user.groups = [];
    }
    if (!user.groups.some(gid => String(gid) === String(group._id))) {
      user.groups.push(group._id);
      await user.save();
    }

    // アクティブグループを更新（セッション）
    req.session.activeGroupId = String(group._id);

    res.json({ id: String(group._id), name: group.group_name || '' });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'conflict', message: '同じ名前のグループが既に存在します' });
    }
    next(err);
  }
});

module.exports = router;
