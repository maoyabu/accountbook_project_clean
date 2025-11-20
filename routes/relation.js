const express = require('express');
const router = express.Router();
const Relation = require('../models/relation');
const User = require('../models/users'); // adjust if different
const { isLoggedIn } = require('../middleware');

const relationshipOptions = [
  '親・先祖',
  '子・孫',
  '配偶者',
  '親戚・兄弟・姉妹',
  '師',
  '友人',
  '地域社会・隣人',
  '職場・仕事関係',
  'その他'
];

// ユーザー検索画面の表示
router.get('/search', isLoggedIn, async (req, res) => {
  res.render('relations/relationsearch', { users: null, relationshipOptions });
});

// ユーザー検索処理（メールまたはユーザー名）
router.post('/search', isLoggedIn, async (req, res) => {
  const keyword = req.body.keyword.trim();
  const users = await User.find({
    $or: [
      { email: { $regex: keyword, $options: 'i' } },
      { username: { $regex: keyword, $options: 'i' } }
    ],
    _id: { $ne: req.user._id }
  });
  res.render('relations/relationsearch', { users, relationshipOptions });
});

// リレーション申請
router.post('/request/:id', isLoggedIn, async (req, res) => {
  const targetUserId = req.params.id;

  const existing = await Relation.findOne({
    userId: req.user._id,
    relationUserId: targetUserId
  });

  if (existing && existing.status !== 'rejected') {
    req.flash('error', 'すでにリレーション申請済みです');
    return res.redirect('/relation');
  }

  if (existing && existing.status === 'rejected') {
    // 再申請：情報更新
    existing.status = 'pending';
    existing.isActive = false;
    existing.relationship = req.body.relationship || 'その他';
    existing.relationNote = [req.body.note || ''];
    existing.noteHistory = [{ content: req.body.note || '', updatedAt: new Date() }];
    existing.requestedAt = new Date();
    existing.createdBy = req.user._id;
    await existing.save();
  } else {
    const newRelation = new Relation({
      userId: req.user._id,
      relationUserId: targetUserId,
      relationship: req.body.relationship || 'その他',
      relationNote: [req.body.note || ''],
      noteHistory: [{ content: req.body.note || '', updatedAt: new Date() }],
      createdBy: req.user._id
    });
    await newRelation.save();
  }

// メール通知機能
  const recipientUser = await User.findById(targetUserId);

  if (recipientUser && recipientUser.email) {
    const { sendMail } = require('../Utils/mailer');

  await sendMail({
    to: recipientUser.email,
    subject: 'リレーション申請のお知らせ',
    templateName: 'relationRequest',
    templateData: {
      senderName: req.user.displayname || req.user.username
    }
  });

  }

  req.flash('success', 'リレーション申請を送信しました');
  res.redirect('/relation');
});

// 自分のリレーション一覧表示
router.get('/', isLoggedIn, async (req, res) => {
  const relations = await Relation.find({
    $or: [
      { userId: req.user._id },
      { relationUserId: req.user._id, status: 'pending' }
    ]
  })
  .populate('relationUserId')
  .populate('userId');

  const currentUser = await User.findById(req.user._id).populate('groups');
  res.render('relations/relation', { relations, relationshipOptions, currentUser });
});

// リレーション詳細ページの表示
router.get('/:id/detail', isLoggedIn, async (req, res) => {
  const relation = await Relation.findById(req.params.id).populate({
    path: 'relationUserId',
    select: 'avatar birth_date sex blood rh displayname username'
  });
  if (!relation || relation.userId.toString() !== req.user._id.toString()) {
    req.flash('error', '対象のリレーションが見つかりません');
    return res.redirect('/relation');
  }
  if (relation.status !== 'approved') {
    req.flash('error', 'まだ未承認の為閲覧することができません');
    return res.redirect('/relation');
  }

  // 共有アクセス情報を取得
  const SharedAccess = require('../models/shared_access');
  const [sharedAccessFromMe, sharedAccessToMe] = await Promise.all([
    SharedAccess.findOne({
      userId: req.user._id.toString(),
      targetUserId: relation.relationUserId._id.toString()
    }),
    SharedAccess.findOne({
      userId: relation.relationUserId._id.toString(),
      targetUserId: req.user._id.toString()
    })
  ]);
  const sharedTypes = Array.isArray(sharedAccessFromMe?.sharedTypes)
    ? sharedAccessFromMe.sharedTypes
    : [];
  const sharedTypesToMe = Array.isArray(sharedAccessToMe?.sharedTypes)
    ? sharedAccessToMe.sharedTypes
    : [];
  // Create links for shared content
  const sharedLinks = {};
  if (sharedTypesToMe.includes('wantolist')) {
    sharedLinks.wantolist = `/allaboutme/wantolist?userId=${relation.relationUserId._id}&fromRelation=1`;
  }
  if (sharedTypesToMe.includes('diary')) {
    sharedLinks.diary = `/allaboutme/eventcal?userId=${relation.relationUserId._id}&fromRelation=1`;
  }
  if (sharedTypesToMe.includes('history')) {
    sharedLinks.history = `/history/list?user=${relation.relationUserId._id}&fromRelation=1`;
  }
  let sharedActiveHistories = [];
  // If 'history' is shared by the other user to me, check if there are actually shared history items
  if (sharedAccessToMe?.sharedTypes.includes('history')) {
    const History = require('../models/history');
    const hasSharedHistory = await History.exists({
      user: relation.relationUserId._id,
      share: true
    });

    // If history is shared and exists, get shared active histories
    if (hasSharedHistory) {
      sharedActiveHistories = await History.find({
        user: relation.relationUserId._id,
        share: true,
        isActive: true
      }).populate('category');
    }

    if (!hasSharedHistory) {
      const index = sharedTypes.indexOf('history');
      if (index > -1) sharedTypes.splice(index, 1);
    }
  }

  const noteHistory = (relation.noteHistory || []).sort((a, b) => b.updatedAt - a.updatedAt);
  const currentUser = await User.findById(req.user._id).populate('groups');
  res.render('relations/relationdetail', {
    relation,
    relationshipOptions,
    noteHistory,
    currentUser,
    sharedTypes,
    sharedTypesToMe,
    sharedLinks,
    sharedActiveHistories
  });
});
  
// リレーション詳細の保存処理
router.put('/:id', isLoggedIn, async (req, res) => {
  const { relationship, relationNote } = req.body;
  const relation = await Relation.findById(req.params.id);

  if (!relation || relation.userId.toString() !== req.user._id.toString()) {
    req.flash('error', '編集権限がありません');
    return res.redirect('/relation');
  }

  // 新しいノートが入力されていれば追加
  if (relationNote && relationNote.trim() !== '') {
    relation.relationNote.push(relationNote.trim());
    relation.noteHistory.push({
      content: relationNote.trim(),
      updatedAt: new Date()
    });
  }

  // 関係性を更新
  relation.relationship = relationship;
  await relation.save();

  // 共有設定の保存
  const SharedAccess = require('../models/shared_access');
  const selectedTypes = Array.isArray(req.body.sharedTypes)
    ? req.body.sharedTypes
    : req.body.sharedTypes ? [req.body.sharedTypes] : [];

  await SharedAccess.findOneAndUpdate(
    { userId: req.user._id, targetUserId: relation.relationUserId },
    { sharedTypes: selectedTypes },
    { upsert: true }
  );

  req.flash('success', 'リレーション情報を更新しました');
  res.redirect('/relation');
});

// リレーション承認処理
router.post('/:id/approve', isLoggedIn, async (req, res) => {
  const relation = await Relation.findById(req.params.id);
  if (!relation || relation.relationUserId.toString() !== req.user._id.toString()) {
    req.flash('error', '承認権限がありません');
    return res.redirect('/relation');
  }

  relation.status = 'approved';
  relation.isActive = true;
  relation.approvedAt = new Date();

  await relation.save();

  // 逆関係マップ
  const reverseMap = {
    '親・先祖': '子・子孫',
    '子・孫': '親・先祖',
    '配偶者': '配偶者',
    '親戚・兄弟・姉妹': '親戚・兄弟・姉妹',
    '師': '教え子',
    '友人': '友人',
    '地域社会・隣人': '地域社会・隣人',
    '職場・仕事関係': '職場・仕事関係',
    'その他': 'その他'
  };
  const reversedRelationship = reverseMap[relation.relationship] || 'その他';

  // 相互リレーションを作成（申請元とは逆方向）
  const mirrorExists = await Relation.findOne({
    userId: relation.relationUserId,
    relationUserId: relation.userId
  });

  if (!mirrorExists) {
    await new Relation({
      userId: relation.relationUserId,
      relationUserId: relation.userId,
      relationship: reversedRelationship,
      relationNote: [],
      isActive: true,
      status: 'approved',
      createdBy: relation.relationUserId,
      noteHistory: [{
        content: '承認',
        updatedAt: new Date()
      }]
    }).save();
  }

  req.flash('success', 'リレーションを承認しました');
  res.redirect('/relation');
});

// リレーション拒否処理
router.post('/:id/reject', isLoggedIn, async (req, res) => {
  const relation = await Relation.findById(req.params.id);
  if (!relation || relation.relationUserId.toString() !== req.user._id.toString()) {
    req.flash('error', '拒否権限がありません');
    return res.redirect('/relation');
  }

  relation.status = 'rejected';
  relation.isActive = false;

  await relation.save();

  req.flash('info', 'リレーション申請を拒否しました');
  res.redirect('/relation');
});

// リレーションブロック処理
router.post('/:id/block', isLoggedIn, async (req, res) => {
  const relation = await Relation.findById(req.params.id);
  if (!relation || relation.relationUserId.toString() !== req.user._id.toString()) {
    req.flash('error', 'ブロック権限がありません');
    return res.redirect('/relation');
  }

    relation.status = 'blocked';
    relation.isActive = false;

    await relation.save();

  req.flash('info', 'リレーション申請をブロックしました');
  res.redirect('/relation');
});


// リレーション申請の取り消し処理
router.delete('/:id', isLoggedIn, async (req, res) => {
  const relation = await Relation.findById(req.params.id);
  if (!relation || relation.userId.toString() !== req.user._id.toString() || relation.status !== 'pending') {
    req.flash('error', '申請取消できるリレーションが見つかりません');
    return res.redirect('/relation');
  }

  await relation.deleteOne();

  req.flash('success', 'リレーション申請を取り消しました');
  res.redirect('/relation');
});



module.exports = router;
