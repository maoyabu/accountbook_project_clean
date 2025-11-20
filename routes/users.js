const express = require('express');
const router = express.Router();
const FinanceUser = require('../models/users');
const passport = require('passport');
const { isLoggedIn, logAction } = require('../middleware');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { sendMail } = require('../Utils/mailer');
const Group = require('../models/groups');
const RegularEntry = require('../models/finance_regularEntry');
const Log = require('../models/log'); // 上部で読み込み

// 必要なモジュール
const multer = require('multer');
const { getStorage } = require('../cloudinary'); // cloudinary config
const upload = () => multer({ storage: getStorage() });

//Topページの表示
router.get('/top', (req,res) => {
    res.render('common/top');
});

//Guideページの表示
router.get('/guide', (req, res) => {
    res.render('common/guide', {
        user: req.user
    });
});

//利用規約ページの表示
router.get('/kiyaku', (req,res) => {
    res.render('common/kiyaku', {
        user: req.user
    });
});

//個人情報保護方針の表示
router.get('/privacy', (req,res) => {
    res.render('common/privacy',{
        user: req.user
    });
});

//ユーザー登録画面の表示
router.get('/register', (req, res) => {
    res.render('users/register', {
        formData: {},   // 初期値として空のオブジェクトを渡す
        errors: {},      // 初期値として空のオブジェクトを渡す
        query: req.query
    });
});

//ユーザー登録処理
router.post('/register', async (req, res, next) => {
    const { username, email, password, password_check } = req.body;
    let errors = {};
    let group = null;

    if (!username) errors.username = 'ユーザー名を入力してください';
    if (!email) errors.email = 'メールアドレスを入力してください';
    if (password !== password_check) errors.password = 'パスワードが一致しません';
    else if (password.length < 8) errors.password = 'パスワードは8文字以上で入力してください';

    if (Object.keys(errors).length > 0) {
        return res.render('users/register', {
            errors,
            formData: { username, email },
            query: req.query
        });
    }
    const groupId = req.body.group || req.query.group;
    try {
        const user = new FinanceUser({ username, email });
        // ✅ 管理者アカウントの自動設定（特定のメールアドレス）
        if (email === process.env.ADMIN_EMAIL) {
            user.isAdmin = true;
        }
        const registeredUser = await FinanceUser.register(user, password);

        // グループ参加処理
        if (groupId) {
            const group = await Group.findById(groupId);

            if (group) {
                // ユーザーをグループに追加
                if (Array.isArray(user.groups) && !user.groups.includes(group._id)) {
                    user.groups.push(group._id);
                    await user.save();
                }
                if (!group.members.includes(registeredUser._id)) {
                    group.members.push(registeredUser._id);
                    await group.save();
                }

                // グループをユーザーに追加
                if (!registeredUser.groups.includes(group._id)) {
                    registeredUser.groups.push(group._id);
                    await registeredUser.save();
                }

                // 🔽 ここでアクティブグループを設定！
                req.session.activeGroupId = group._id;

                // 招待リストから削除
                const emailIndex = group.invitedUsers.indexOf(email);
                if (emailIndex !== -1) {
                    group.invitedUsers.splice(emailIndex, 1);
                    await group.save();
                }
            }
        }

        req.session.save(err => {
            if (err) return next(err);

            req.flash('success', `${username}さん、ようこそ！`);
            res.redirect('/myTop/top');
        });

    } catch (e) {
        if (e.code === 11000 && e.keyPattern?.email) {
            req.flash('error', 'そのメールアドレスはすでに登録されています');
        } else {
            req.flash('error', e.message); // その他のエラー
        }
        return res.redirect('/register');
    }
});

//ログインの画面表示
router.get('/login', (req, res) => {
    res.render('users/login',{
        page: 'login' // ←これがないとエラーになる構成だった
    });
});

//ログイン処理
router.post('/login',
  async (req, res, next) => {
    const { username, password } = req.body;

    const user = await FinanceUser.findOne({
      $or: [{ username: username }, { email: username }]
    });

    if (!user) {
      req.flash('error', 'ユーザー名またはメールアドレスが無効です');
      return res.redirect('/login');
    }

    req.body.username = user.username;
    next();
  },
  passport.authenticate('local', {
    failureFlash: true,
    failureRedirect: '/login'
  }),
  async (req, res) => {
    const user = await FinanceUser.findById(req.user._id).populate('groups');

    // ✅ ログイン成功ログを記録
    await Log.create({
      type: 'login',
      username: user.username,
      userId: user._id,
      ip: req.ip,
      success: true
    });

    if (user.groups.length > 0) {
      req.session.activeGroupId = user.groups[0]._id;
      await logAction({ req, action: 'ログイン', target: 'ユーザー' });
      req.flash('success', `ようこそ！${req.user.username}さん、おかえりなさい！`);
      const redirectUrl = req.session.returnTo || '/myTop/top';
      delete req.session.returnTo;
      return res.redirect(redirectUrl);
    } else {
      req.flash('success', `${req.user.username}さん、まず始めにグループの作成をするか、グループの管理者から招待を受けて下さい`);
      return res.redirect('/setting');
    }
  }
);

//ログアウト処理
router.get('/logout', (req, res) => {
    req.logout(function(err) {
        if (err) {
            return next(err);
        }
        req.flash('success', 'ログアウトしました');
        res.redirect('/login');
    });
});

//パスワード再設定の画面の表示
router.get('/forgot-password', (req, res) => {
    res.render('users/forgot-password');  // forgot-password.ejsを表示
});

//パスワード変更画面の表示
router.get('/reset-password', isLoggedIn, async (req, res) => {
    const user = await FinanceUser.findById(req.user._id).populate('groups');
    res.render('users/reset-password', {
        currentUser: user
    });
});

//パスワード変更処理
router.post('/reset-password', isLoggedIn, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
        req.flash('error', '新しいパスワードが一致しません');
        return res.redirect('/reset-password');
    }

    try {
        const user = await FinanceUser.findById(req.user._id);
        const isMatch = await user.authenticate(currentPassword);

        if (!isMatch.user) {
            req.flash('error', '現在のパスワードが間違っています');
            return res.redirect('/reset-password');
        }

        await user.setPassword(newPassword);
        await user.save();

        req.flash('success', 'パスワードを変更しました');
        res.redirect('/profile');
    } catch (err) {
        console.error('パスワード変更エラー:', err);
        req.flash('error', 'パスワードの変更に失敗しました');
        res.redirect('/reset-password');
    }
});

//パスワード忘れのメール送信
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    const user = await FinanceUser.findOne({ email });
    if (!user) {
        req.flash('error', 'そのメールアドレスは登録されていません');
        return res.redirect('/forgot-password');
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

    req.flash('success', 'パスワード再設定用のリンクをメールで送信しました');
    res.redirect('/login');
});

// パスワードリセット画面表示
router.get('/reset/:token', async (req, res) => {
    const user = await FinanceUser.findOne({
        resetPasswordToken: req.params.token,
        resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
        req.flash('error', 'パスワードリセットリンクが無効または期限切れです');
        return res.redirect('/forgot-password');
    }

    res.render('users/change-password', { token: req.params.token });
});

// パスワードリセット処理（新しいパスワードを保存）
router.post('/reset/:token', async (req, res) => {
    const { password, confirm } = req.body;

    if (password !== confirm) {
        req.flash('error', 'パスワードが一致しません');
        return res.redirect('back');
    }

    const user = await FinanceUser.findOne({
        resetPasswordToken: req.params.token,
        resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
        req.flash('error', 'パスワードリセットリンクが無効または期限切れです');
        return res.redirect('/forgot-password');
    }

    try {
        await user.setPassword(password);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        req.login(user, err => {
            if (err) {
                console.error('ログインエラー:', err);
                req.flash('error', 'パスワードは更新されましたが自動ログインに失敗しました');
                return res.redirect('/login');
            }
            req.flash('success', 'パスワードが正常にリセットされました');
            res.redirect('/finance/list');
        });
    } catch (err) {
        console.error('パスワードリセット処理エラー:', err);
        req.flash('error', 'エラーが発生しました');
        res.redirect('/forgot-password');
    }
});


// ユーザー退会処理
router.post('/unsubscribe', isLoggedIn, async (req, res) => {
    try {
        const user = await FinanceUser.findById(req.user._id).populate('groups');
        const currentDate = new Date();
        const timestamp = currentDate.toISOString().slice(0,10).replace(/-/g, '');
        const suffix = `deleteduser${timestamp}_${Math.floor(1000 + Math.random() * 9000)}`;

        // グループオーナー確認
        const ownedGroups = await Group.find({ createdBy: user._id });
        if (ownedGroups.length > 0) {
            req.flash('error', 'グループのオーナーになっているため退会できません。他のメンバーにオーナー権限を譲渡してください。');
            return res.redirect('/profile');
        }

        // ユーザー情報の変更（プライバシー情報の削除）
        user.username = `${user.username}_${suffix}`;
        user.displayname = user.displayname ? `${user.displayname}_${suffix}` : '';
        user.email = `deleted_${suffix}@example.com`;
        user.birth_date = undefined;
        user.avatar = undefined;
        user.unsubscribe_date = currentDate;
        await user.save();

        // 関連データの削除
        await Promise.all([
            require('../models/finance_assets').deleteMany({ user: user._id }),
            require('../models/allaboutme_eventcal').deleteMany({ user: user._id }),
            require('../models/allaboutme_wantolist').deleteMany({ user: user._id }),
            RegularEntry.deleteMany({ user: user._id })
        ]);

        req.logout(err => {
            if (err) {
                console.error('ログアウトエラー:', err);
            }
            req.flash('success', '退会処理が完了しました。ご利用ありがとうございました。');
            res.redirect('/login');
        });

    } catch (err) {
        console.error('退会処理エラー:', err);
        req.flash('error', '退会処理中にエラーが発生しました');
        res.redirect('/profile');
    }
});

//設定画面の表示
router.get('/setting', (req,res) => {
    res.render('setting', { page: 'setting' });
});

//プロフィール設定 表示 2）参加しているグループ、3）管理者かどうかを表示させる
router.get('/profile', isLoggedIn, async (req, res) => {
    try {
      const Resume = require('../models/resume');
      const user = await FinanceUser.findById(req.user._id)
        .populate({
          path: 'groups',
          populate: { path: 'createdBy' }
        })
        // .populate('resume'); // resume を populate

      const resume = await Resume.findOne({ user: user._id });
      // activeGroupIdをEJSに渡す
      res.render('profile', {
        user,  // ユーザー情報
        activeGroupId: req.session.activeGroupId,  // activeGroupIdを渡す
        availableServices: ['allaboutme', 'finance', 'asset'],
        resume
      });
    } catch (err) {
      console.error('プロフィール取得エラー:', err);
      req.flash('error', 'プロフィールの取得に失敗しました');
      res.redirect('/login');
    }
  });

//プロフィールの更新
router.put('/profile/:id', isLoggedIn, (req, res, next) => {
  const uploadAvatar = upload().single('avatar');
  uploadAvatar(req, res, function (err) {
    if (err) {
      req.flash('error', '画像のアップロードに失敗しました');
      return res.redirect('/profile');
    }

    // ここからは通常の非同期ルート
    (async () => {
      try {
        const user = await FinanceUser.findById(req.params.id);
        if (!user) {
          req.flash('error', 'ユーザーが見つかりませんでした');
          return res.redirect('/profile');
        }

        user.displayname = req.body.displayname;
        user.email = req.body.email;
        user.birth_date = req.body.birth_date ? new Date(req.body.birth_date) : null;
        user.blood = req.body.blood;
        user.sex = req.body.sex;
        user.rh = req.body.rh;
        user.update_date = new Date();
        user.isMail = req.body.isMail === 'true' || req.body.isMail === 'on';

        // 利用サービスの設定を保存
        user.services = {
          allaboutme: req.body.services_allaboutme === 'true',
          finance: req.body.services_finance === 'true',
          assets: req.body.services_assets === 'true'
        };

        if (req.file) {
          user.avatar = req.file.path;
        }

        await user.save();
        req.flash('success', 'プロフィールを更新しました');
        await logAction({ req, action: 'プロフィールの更新', target: 'プロフィール' });
        res.redirect('/profile');
      } catch (e) {
        req.flash('error', '更新中に問題が発生しました');
        res.redirect('/profile');
      }
    })();
  });
});

module.exports = router;
