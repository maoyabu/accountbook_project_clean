require('dotenv').config();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const express = require('express');
const router = express.Router();
const { isLoggedIn, logAction } = require('../middleware');
const Group = require('../models/groups');
const FinanceUser = require('../models/users');
const Budget = require('../models/finance_ex_budget');

const nodemailer = require('nodemailer');
const { sendMail } = require('../Utils/mailer');

const ex_cfs = ['Please Choice','副食物費','主食費1','主食費2','調味料','光熱費','住宅・家具費','衣服費','教育費','交際費','教養費','娯楽費','保険・衛生費','職業費','特別費','公共費','車関連費','通信費'];


//Group作成画面を表示させる
router.get('/', isLoggedIn, async (req, res) => {
  const groups = await Group.find({ members: req.user._id }).populate('createdBy');
  res.render('groups/group_entry', { groups });
});

//POSTルート（グループ作成）
router.post('/', isLoggedIn, async (req, res) => {
    const newGroup = new Group({
      group_name: req.body.group_name,
      createdBy: req.user._id,
      members: [req.user._id]  // 管理者自身をメンバーとして追加
    });
  
    await newGroup.save();
    await logAction({ req, action: '登録', target: 'グループ'});
    const user = await FinanceUser.findById(req.user._id);
    if (user) {
      user.groups.push(newGroup._id);
      await user.save();
    }
    await logAction({ req, action: 'グループ作成', target: 'グループ'});
    req.flash('success', 'グループを作成しました');
    const groups = await Group.find({ members: req.user._id }).populate('createdBy');
    res.render('groups/group_entry', { groups });
  });

// グループ名編集ルート
router.put('/:id/edit-name', isLoggedIn, async (req, res) => {
  const { id } = req.params;
  const { group_name } = req.body;
  try {
    const group = await Group.findById(id);
    if (!group) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/group');
    }
    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', '編集できるのは作成者のみです');
      return res.redirect('/group');
    }
    group.group_name = group_name;
    await group.save();
    await logAction({ req, action: 'グループ名更新', target: 'グループ'});
    req.flash('success', 'グループ名を更新しました');
    res.redirect('/group');
  } catch (err) {
    console.error('グループ名更新エラー:', err);
    req.flash('error', 'グループ名の更新に失敗しました');
    res.redirect('/group');
  }
});

// 招待メール送信処理
router.post('/invite/:id', isLoggedIn, async (req, res) => {
    const { invite_email } = req.body;
    const groupId = req.params.id;
    const group = await Group.findById(groupId);
    await group.populate('createdBy');
  
    if (!group) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/group/group_list');
    }
  
    try {
      await sendMail({
        to: invite_email,
        subject: '【家計簿】グループへの招待',
        templateName: 'invite',
        templateData: {
          inviter: group.createdBy.displayname || group.createdBy.username,
          groupName: group.group_name,
          inviteUrl: `${BASE_URL}/group/group_accept/${group._id}?email=${invite_email}`
        }
      });
      await logAction({ req, action: '招待メール送信', target: 'グループ'});
      req.flash('success', `${invite_email} に招待メールを送信しました`);
    } catch (err) {
      console.error('📩 メール送信エラー:', err);
      req.flash('error', 'メールの送信に失敗しました');
      return res.redirect(`/group/show/${groupId}`);
    }

    try {
        if (!Array.isArray(group.invitedUsers)) {
            group.invitedUsers = [];
        }
        if (!group.invitedUsers.includes(invite_email)) {
            group.invitedUsers.push(invite_email);
            await group.save();
        }
    } catch (err) {
        console.error('📁 グループ更新エラー:', err);
        req.flash('error', '招待情報の保存に失敗しました');
        return res.redirect(`/show/${groupId}`);
    }
  
    res.redirect(`/group/show/${groupId}`);
  });

// 再招待メール送信
router.post('/group_reinvite/:id', isLoggedIn, async (req, res) => {
    const { invite_email } = req.body;
    const groupId = req.params.id;
    const group = await Group.findById(groupId).populate('createdBy');
  
    if (!group) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/group/group_list');
    }
  
    // 権限チェック
    if (!group.createdBy.equals(req.user._id)) {
      req.flash('error', '管理者のみ再招待できます');
      return res.redirect(`/group/show/${groupId}`);
    }
  
    try {
      await sendMail({
        to: invite_email,
        subject: '【家計簿】グループへの再招待',
        templateName: 'invite',
        templateData: {
          inviter: group.createdBy.displayname || group.createdBy.username,
          groupName: group.group_name,
          inviteUrl: `${BASE_URL}/group/group_accept/${group._id}?email=${invite_email}`
        }
      });
      await logAction({ req, action: '招待メール再送信', target: 'グループ'});
      req.flash('success', `${invite_email} に再招待メールを送信しました`);
    } catch (err) {
      console.error('📩 再招待メール送信エラー:', err);
      req.flash('error', '再招待メールの送信に失敗しました');
    }  

    res.redirect(`/group/show/${groupId}`);
  }); 

// グループ招待承諾ルート
router.get('/group_accept/:groupId', async (req, res) => {
    const { groupId } = req.params;
    const { email } = req.query;

    if (!email) {
        req.flash('error', 'メールアドレスが指定されていません');
        return res.redirect('/login');
    }

    const group = await Group.findById(groupId);
    if (!group) {
        req.flash('error', 'グループが見つかりませんでした');
        return res.redirect('/finance/list');
    }

    try {
        const user = await FinanceUser.findOne({ email });

        if (!user) {
            // メッセージを表示して会員登録していない場合は登録ページへ誘導（招待情報はURLに残しておく）
            req.flash('success', `"${group.group_name}" グループに参加しました。ご利用には会員登録が必要です`);
            return res.redirect(`/register?group=${groupId}&email=${encodeURIComponent(email)}`);
        }

        // 登録済みユーザー：グループに追加（重複チェック）
        if (!group.members.some(id => id.equals(user._id))) {
            group.members.push(user._id);
            await group.save();
        }

        if (!user.groups.some(id => id.equals(group._id))) {
            user.groups.push(group._id);
            await user.save();
        }

        // 招待されたメールアドレスを削除
        const index = group.invitedUsers.indexOf(email);
        if (index !== -1) {
            group.invitedUsers.splice(index, 1);
            await group.save();
        }
        await logAction({ req, action: '招待承諾', target: 'グループ'});
        req.flash('success', `${group.group_name} グループへの参加が完了しました`);
        return res.redirect('/login');
    } catch (err) {
        console.error('グループ参加エラー:', err);
        req.flash('error', 'グループへの参加中にエラーが発生しました');
        return res.redirect('/login');
    }
});

// 招待取り消しルート
router.delete('/group_cancel_invite/:groupId', isLoggedIn, async (req, res) => {
  const { groupId } = req.params;
  const { invite_email } = req.body;

  try {
    const group = await Group.findById(groupId);
    if (!group) {
      req.flash('error', 'グループが見つかりませんでした');
      return res.redirect('/group/group_list');
    }

    // 招待されたメールアドレスを削除
    const index = group.invitedUsers.indexOf(invite_email);
    if (index !== -1) {
      group.invitedUsers.splice(index, 1);
      await group.save();
      req.flash('success', `「${invite_email}」への招待を取り消しました`);
    } else {
      req.flash('info', `「${invite_email}」は招待リストにありません`);
    }
    await logAction({ req, action: '招待取消', target: 'グループ'});
    return res.redirect(`/group/show/${groupId}`);
  } catch (err) {
    console.error('招待取り消しエラー:', err);
    req.flash('error', '招待取り消し中にエラーが発生しました');
    return res.redirect(`/group/show/${groupId}`);
  }
});

// GETルート：グループ切り替え（フォームから来ない場合）
router.get('/budget/setup', isLoggedIn, async (req, res) => {
  const groupId = req.session.activeGroupId;
  const year = new Date().getFullYear();

  if (!groupId) {
    req.flash('error', 'グループが未選択です');
    return res.redirect('/group');
  }

  const existingBudgets = await Budget.find({ group: groupId, year });

  const budgetItems = existingBudgets.length > 0
    ? existingBudgets
    : ex_cfs.slice(1).map(item => ({
        expense_item: item,
        budget: 0
      }));

  res.render('finance/budget', {
    groupId,
    year,
    budgetItems,
    layout: false
  });
});

//ログイン後やナビバーでグループ選択時にactiveGroupIdを設定
router.post('/select', isLoggedIn, async (req, res) => {
  const { groupId } = req.body;
  const group = await Group.findById(groupId);
  if (!group || !group.members.includes(req.user._id)) {
    req.flash('error', 'そのグループには所属していません');
    return res.redirect('/group_list');
  }
  req.session.activeGroupId = group._id;

  const previousUrl = req.get('Referrer') || '';
  if (previousUrl.includes('/show')) {
    // グループ詳細画面から来た場合のみ、別のグループ詳細へリダイレクト
    return res.redirect(`/group/show/${group._id}`);
  }
  // それ以外の画面からの変更は元の画面へ
  res.redirect('back');
});

// グループの詳細画面の表示
router.get('/show/:id', isLoggedIn, async (req, res) => {
    const group = await Group.findById(req.params.id)
        .populate('createdBy')
        .populate('members')
        .populate('invitedUsers');

        const currentYear = new Date().getFullYear();
        const groups = await Group.find({ members: req.user._id }).populate('createdBy'); // ✅ プルダウン用
        const user = await FinanceUser.findById(req.user._id).populate('groups');

    if (!group) {
      req.flash('error', 'グループが見つかりません');
      return res.redirect('/group_list');
    }
    res.render('groups/show', {
       group,
       groups,                        // ✅ プルダウン用
       currentUser: user, // ← populate済みのuserを渡す
       activeGroupId: req.session.activeGroupId,
       selectedYear: currentYear // ← 追加！
      });
  });

//グループからメンバーを退会させるルート
router.delete('/group_remove_member/:groupId/:userId', isLoggedIn, async (req, res) => {
    const { groupId, userId } = req.params;
  
    try {
      const group = await Group.findById(groupId);
      if (!group) {
        req.flash('error', 'グループが見つかりません');
        return res.redirect('/group/group_list');
      }
  
      // 管理者であるかチェック
      if (!group.createdBy.equals(req.user._id)) {
        req.flash('error', '退会させる権限がありません');
        return res.redirect('/group/show/' + groupId);
      }
  
      // グループのメンバーから削除
      group.members = group.members.filter(memberId => memberId.toString() !== userId);
      await group.save();
  
      // ユーザー側のgroupsからも削除
      const user = await FinanceUser.findById(userId);
      if (user) {
        user.groups = user.groups.filter(gid => gid.toString() !== groupId);
        await user.save();
      }
      await logAction({ req, action: '退会', target: 'グループ'});
      req.flash('success', 'メンバーを退会させました');
      res.redirect('/group/show/' + groupId);
    } catch (err) {
      console.error('退会エラー:', err);
      req.flash('error', '退会処理中にエラーが発生しました');
      res.redirect('/group/show/' + groupId);
    }
  });

// グループ削除処理
router.delete('/:id', isLoggedIn, async (req, res) => {
    try {
      const group = await Group.findById(req.params.id);
  
      // 存在チェック & 管理者かどうかチェック
      if (!group) {
        req.flash('error', 'グループが見つかりませんでした');
        return res.redirect('/group/group_list');
      }
  
      if (!group.createdBy.equals(req.user._id)) {
        req.flash('error', '削除できるのは管理者のみです');
        return res.redirect('/group/group_list');
      }
  
      // 参加ユーザーからこのグループを削除
      const members = await FinanceUser.find({ _id: { $in: group.members } });
      for (let member of members) {
        member.groups = member.groups.filter(gid => !gid.equals(group._id));
        await member.save();
      }
  
      // 招待中のユーザーはメールだけなので、DBにはユーザーとして存在しない前提
  
      // グループ削除
      await Group.findByIdAndDelete(group._id);
      await logAction({ req, action: '削除', target: 'グループ'});
  
      req.flash('success', 'グループを削除しました');
      const groups = await Group.find({ members: req.user._id }).populate('createdBy');
      res.render('groups/group_entry', { groups });
    } catch (err) {
      console.error('❌ グループ削除エラー:', err);
      req.flash('error', 'グループ削除中にエラーが発生しました');
      const groups = await Group.find({ members: req.user._id }).populate('createdBy');
      res.render('groups/group_entry', { groups });
    }
  });

  //グループの切替
router.get('/:id/switch', isLoggedIn, async (req, res) => {
  const groupId = req.params.id;
  // Open redirect 防止: サイト内パスのみに限定
  let redirectTo = typeof req.query.redirect === 'string' ? req.query.redirect : '/';
  if (!redirectTo.startsWith('/')) {
    redirectTo = '/';
  }

  // 所属チェック
  const group = await Group.findById(groupId);
  if (!group) {
    req.flash('error', '指定されたグループが見つかりません');
    return res.redirect('/');
  }

  const belongsToGroup = req.user.groups.some(g => g.toString() === groupId);
  if (!belongsToGroup) {
    req.flash('error', 'そのグループに所属していません');
    return res.redirect('/');
  }

  // グループ切り替え
  req.session.activeGroupId = groupId;
  res.redirect(redirectTo);
});

module.exports = router;
