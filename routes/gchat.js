const express = require('express');
const router = express.Router();
const catchAsync = require('../Utils/catchAsync');
const mongoose = require('mongoose');
const isLoggedIn = require('../middleware').isLoggedIn;
const GChat = require('../models/gChat');
const GChatMessage = require('../models/gChatMessage');
const User = require('../models/users');
const Group = require('../models/groups');

// gchat画面の表示
router.get('/', isLoggedIn, catchAsync(async (req, res) => {
  const activeGroupId = req.session.activeGroupId;
  if (!activeGroupId) {
    req.flash('error', 'アクティブなグループが選択されていません');
    return res.redirect('/group_list');
  }

  // グループメンバーを取得
  const group = await mongoose.model('Group').findById(activeGroupId).populate('members');
  const groupMembers = group ? group.members : [];

  // チャット情報を取得（仮: chats モデルがある場合のみ。なければ空配列）
  let chats = [];
  try {
    chats = await GChat.find({ group: activeGroupId }).populate('createdBy').sort({ createdAt: 1 });
  } catch (e) {
    // GChatモデルが存在しなければ空配列
    chats = [];
  }
  // フィルター：ログインユーザーが含まれていないチャットを除外
  chats = chats.filter(chat => chat.members.map(id => id.toString()).includes(req.user._id.toString()));

  // 各チャットに対して最新メッセージと未読数を付加
  const chatsWithMeta = await Promise.all(chats.map(async chat => {
    const latestMessage = await GChatMessage.findOne({ chat: chat._id })
      .populate('sender')
      .sort({ createdAt: -1 });

    const unreadCount = await GChatMessage.countDocuments({
      chat: chat._id,
      readBy: { $ne: req.user._id }
    });

    return {
      ...chat.toObject(),
      latestMessage: latestMessage ? latestMessage.message : '',
      latestMessageAt: latestMessage ? latestMessage.createdAt : null,
      latestSender: latestMessage ? latestMessage.sender : null,
      unreadCount
    };
  }));

  // 各チャットに参加者アバターを追加（最大3件）
  for (const chat of chatsWithMeta) {
    // members配列が空でなければそのユーザー、空ならcreatedByのみ
    let chatMembers = [];
    if (chat.members && chat.members.length > 0) {
      chatMembers = await User.find({ _id: { $in: chat.members } });
    } else if (chat.createdBy) {
      // createdByはUserオブジェクトまたはID
      if (typeof chat.createdBy === 'object' && chat.createdBy.avatar) {
        chatMembers = [chat.createdBy];
      } else {
        const user = await User.findById(chat.createdBy);
        if (user) chatMembers = [user];
      }
    }

    const currentUser = await User.findById(req.user._id);
    const memberMap = new Map();
    [...chatMembers, currentUser].forEach(member => {
      memberMap.set(member._id.toString(), member);
    });
    chat.avatars = Array.from(memberMap.values()).slice(0, 3).map(member =>
      member.avatar && member.avatar.trim() !== '' ? member.avatar : '/images/default-avatar.png'
    );
    chat.members = Array.from(memberMap.values());
  }

  // currentUserにgroupsをpopulateして取得
  const currentUser = await User.findById(req.user._id).populate('groups');

  // 他のグループのチャット（ログインユーザーが参加していて、現在のグループと異なる）
  const otherGroupChatsRaw = await GChat.find({
    group: { $ne: activeGroupId },
    members: req.user._id
  }).populate('group', 'group_name').sort({ createdAt: 1 });

  const otherGroupChats = await Promise.all(otherGroupChatsRaw.map(async chat => {
    const latestMessage = await GChatMessage.findOne({ chat: chat._id })
      .populate('sender')
      .sort({ createdAt: -1 });

    const isUserInGroup =
      chat.group && currentUser.groups.some(g => g._id.toString() === chat.group._id.toString());
    const groupName = isUserInGroup ? chat.group.group_name : '別のグループ';

    return {
      ...chat.toObject(),
      group: chat.group ? { _id: chat.group._id, name: groupName } : null,
      latestMessage: latestMessage ? latestMessage.message : '',
      latestMessageAt: latestMessage ? latestMessage.createdAt : null,
      latestSender: latestMessage ? latestMessage.sender : null
    };
  }));

  res.render('gchat/gchat', {
    currentUser,
    groupMembers,
    activeGroupId,
    chats: chatsWithMeta,
    otherGroupChats,
    page: 'gchat'
  });
}));

// 新規チャット作成 POST
router.post('/create', isLoggedIn, async (req, res) => {
  try {
    const { title, type, targetUserId } = req.body;
    const groupId = req.session.activeGroupId;
    const creatorId = req.user._id;

    if (!title || !type || !groupId || (type === 'private' && !targetUserId)) {
      req.flash('error', '必要な情報が不足しています');
      return res.redirect('/gchat');
    }

    let members = [];
    if (type === 'group') {
      const group = await Group.findById(groupId).populate('members');
      members = group.members.map(m => m._id.toString());
    } else {
      members = [targetUserId.toString(), creatorId.toString()];
    }

    const chat = new GChat({
      title,
      group: groupId,
      createdBy: creatorId,
      members,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await chat.save();

    // Populate avatars (max 3: currentUser and up to 2 members)
    const currentUser = await User.findById(creatorId);
    const otherMembers = await User.find({ _id: { $in: chat.members } });
    const memberMap = new Map();
    [...otherMembers, currentUser].forEach(member => {
      memberMap.set(member._id.toString(), member);
    });
    chat.avatars = Array.from(memberMap.values()).slice(0, 3).map(member =>
      member.avatar && member.avatar.trim() !== '' ? member.avatar : '/images/default-avatar.png'
    );

    req.flash('success', 'チャットを作成しました');
    res.redirect(`/gchat/${chat._id}`);
  } catch (err) {
    console.error('チャット作成エラー:', err);
    req.flash('error', 'チャットの作成に失敗しました');
    res.redirect('/gchat');
  }
});

// 特定チャットの詳細表示
router.get('/:chatId', isLoggedIn, async (req, res) => {
  const chat = await GChat.findById(req.params.chatId)
    .populate('createdBy')
    .populate('group');

  const messages = await GChatMessage.find({ group: chat.group, chat: chat._id })
    .populate('sender')
    .populate('readBy')
    .sort({ createdAt: 1 });

  // すべての未読メッセージに現在のユーザーを追加して既読にする
  await GChatMessage.updateMany(
    { chat: chat._id, readBy: { $ne: req.user._id } },
    { $addToSet: { readBy: req.user._id } }
  );

  const chatMembers = await User.find({ _id: { $in: chat.members } });
  const currentUser = await User.findById(req.user._id).populate('groups');
  const memberMap = new Map();
  [...chatMembers, currentUser].forEach(member => {
    memberMap.set(member._id.toString(), member);
  });
  chat.members = Array.from(memberMap.values());
  chat.avatars = Array.from(memberMap.values()).slice(0, 3).map(member =>
    member.avatar && member.avatar.trim() !== '' ? member.avatar : '/images/default-avatar.png'
  );
  // Ensure group name is accurate based on membership
  const isUserInGroup = currentUser.groups.some(g => g._id.toString() === chat.group._id.toString());
  chat.group = {
    _id: chat.group._id,
    group_name: isUserInGroup ? chat.group.group_name : '別のグループ'
  };
  res.render('gchat/gchatdetail', { chat, messages, currentUser });
});

// 特定チャット内のメッセージ送信処理
router.post('/:chatId/send', isLoggedIn, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text } = req.body;

    if (!text.trim()) {
      req.flash('error', 'メッセージを入力してください');
      return res.redirect(`/gchat/${chatId}`);
    }

    const chat = await GChat.findById(chatId);
    if (!chat) {
      req.flash('error', 'チャットが見つかりません');
      return res.redirect('/gchat');
    }

    const newMessage = new GChatMessage({
      group: chat.group,
      sender: req.user._id,
      chat: chatId,
      message: text,
      readBy: [req.user._id]
    });

    await newMessage.save();

    chat.updatedAt = new Date();
    await chat.save();

    res.redirect(`/gchat/${chatId}`);
  } catch (err) {
    console.error('メッセージ送信エラー:', err);
    req.flash('error', 'メッセージの送信に失敗しました');
    res.redirect('/gchat');
  }
});

// チャット削除
router.delete('/:chatId/delete', isLoggedIn, async (req, res) => {
  try {
    const { chatId } = req.params;

    // チャット本体の削除
    await GChat.findByIdAndDelete(chatId);

    // 関連メッセージの削除
    await GChatMessage.deleteMany({ chat: chatId });

    req.flash('success', 'チャットを削除しました');
    res.redirect('/gchat');
  } catch (err) {
    console.error('チャット削除エラー:', err);
    req.flash('error', 'チャットの削除に失敗しました');
    res.redirect('/gchat');
  }
});

// メッセージ削除
router.delete('/:chatId/message/:messageId', isLoggedIn, async (req, res) => {
  const { chatId, messageId } = req.params;
  const message = await GChatMessage.findById(messageId);
  if (!message) {
    req.flash('error', 'メッセージが見つかりません');
    return res.redirect(`/gchat/${chatId}`);
  }
  if (!message.sender.equals(req.user._id)) {
    req.flash('error', '自分のメッセージのみ削除できます');
    return res.redirect(`/gchat/${chatId}`);
  }

  await GChatMessage.findByIdAndDelete(messageId);
  req.flash('success', 'メッセージを削除しました');
  res.redirect(`/gchat/${chatId}`);
});

module.exports = router;