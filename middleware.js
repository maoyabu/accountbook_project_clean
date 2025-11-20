const FinanceUser = require('./models/users');
const Log = require('./models/log');
const SharedAccess = require('./models/shared_access');

module.exports.isLoggedIn = (req, res, next) => {
    //req.isAuthenticated()はpassportが提供しているメソッドで、ログインしているかどうかを判定する
    //ログインしていない場合は、flashメッセージを表示して/loginにリダイレクトする
    //ログインしている場合は、次のミドルウェアに処理を渡す
    //元々リクエストした場所を保存しておき、リダイレクトの時にその場所に戻す
    if (!req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        req.flash('error', 'ログインしてください');
        return res.redirect('/login');
    }
    next();
}

module.exports.storeReturnTo = (req, res, next) => {
    if (req.session.returnTo) {
        res.locals.returnTo = req.session.returnTo;
    }
    next();
}

//ミドルウェアでアクティブグループをチェック・提供
module.exports.setActiveGroup = async (req, res, next) => {
  if (req.user) {
    try {
      const populatedUser = await FinanceUser.findById(req.user._id).populate('groups');
      req.user = populatedUser; // Overwrite req.user for Passport
      res.locals.currentUser = populatedUser;
    } catch (err) {
      console.error('ユーザー情報の取得に失敗:', err);
      req.flash('error', 'ユーザー情報の取得に失敗しました');
      res.locals.currentUser = null;
    }
    res.locals.activeGroupId = req.session.activeGroupId || null;
  } else {
    res.locals.currentUser = null;
    res.locals.activeGroupId = null;
  }
  next();
};

//login確認用のミドルウェア
module.exports.ensureAuthenticated = (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return next();
    }
    res.redirect('/login');
};

//管理者画面に入るときのチェック用ミドルウェア
module.exports.isAdmin = (req, res, next) => {
  if (req.isAuthenticated() && req.user.isAdmin) {
    return next();
  }
  req.flash('error', '管理者専用ページです');
  return res.redirect('/');
};

// ログインログを記録する（ログイン成功直後のルートで使用）
module.exports.logLoginSuccess = async (req, res, next) => {
    if (req.user) {
        await Log.create({
            type: 'login',
            username: req.user.username,
            userId: req.user._id,
            ip: req.ip,
            success: true
        });
    }
    next();
};

// ページアクセスログ（全てのリクエストに使用可能）
module.exports.logPageAccess = async (req, res, next) => {
    if (req.user) {
        await Log.create({
            type: 'page',
            username: req.user.username,
            userId: req.user._id,
            page: req.originalUrl,
            ip: req.ip
        });
    }
    next();
};

//アクションログの取得
module.exports.logAction = async ({ req, action, target }) => {
  if (!req.user) return;

  await Log.create({
    type: 'action',
    username: req.user.username,
    userId: req.user._id,
    ip: req.ip,
    action,
    target
  });
};

//共有項目のアクセス権をチェックするミドルウェア
const checkSharedAccess = (type) => {
  return async (req, res, next) => {
    const selectedUserId = req.query.user || req.user._id.toString();
    if (selectedUserId === req.user._id.toString()) return next();

    const access = await SharedAccess.findOne({
      userId: selectedUserId,
      targetUserId: req.user._id,
      sharedTypes: type
    });

    if (!access) {
      req.flash('error', 'この情報を閲覧する権限がありません');
      return res.redirect('/myTop/top');
    }
    next();
  };
};