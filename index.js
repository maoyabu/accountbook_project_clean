// 起動デバッグ用（どこで止まっているかを特定）
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});
require('dotenv').config();
const path = require('path');
const fs = require('fs');

// 🔐 Google Cloud 認証情報 (Base64文字列 → .jsonファイルに復元)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 && process.env.NODE_ENV === 'production') {
  const configDir = path.join(__dirname, 'config');
  const credentialsPath = path.join(configDir, 'accountbook.json');
  const raw = String(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 || '').trim();

  // configディレクトリが存在しなければ作成
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let jsonText = raw;
  if (!raw.startsWith('{')) {
    try {
      jsonText = Buffer.from(raw, 'base64').toString('utf-8');
    } catch (err) {
      console.error('❌ Google 認証情報のBase64デコードに失敗:', err);
      jsonText = '';
    }
  }

  try {
    JSON.parse(jsonText);
    fs.writeFileSync(credentialsPath, jsonText);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    console.log('✅ Google 認証情報ファイルを書き出しました');
  } catch (err) {
    console.error('❌ Google 認証情報がJSONとして不正です。BASE64はサービスアカウントJSON全体を設定してください。');
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
}
const express = require('express');
const app = express();

// Basic security hardening
app.disable('x-powered-by');
// Heroku など本番環境だけ HTTPS リダイレクト
if (process.env.NODE_ENV === 'production') {
  app.enable('trust proxy');
app.use((req, res, next) => {
  if (req.hostname === 'allaboutme.jp') {
    return res.redirect(301, `https://www.allaboutme.jp${req.url}`);
  }
  next();
});
}
const mongoose = require('mongoose');
const methodOverride = require('method-override');
const ejsMate = require('ejs-mate');
const ExpressError = require('./Utils/ExpressError');
const session = require('express-session');

// ✅ ここから下は後半で参照しているので必ず require する
const flash = require('express-flash');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const FinanceUser = require('./models/users');

const googlePhotosRouter = require('./routes/googlePhotos');
const ocrRoutes = require('./routes/ocr');

const financeRoutes = require('./routes/finance');
const userRoutes = require('./routes/users');
const outputRoutes = require('./routes/output');
const groupRoutes = require('./routes/groups');
const manageRoutes = require('./routes/manage');
const matometeRoutes = require('./routes/matomete');
const assetRoutes = require('./routes/asset');
const allaboutmeRoutes = require('./routes/allaboutme');
const eventcal2Routes = require('./routes/eventcal2');
const myTopRoutes = require('./routes/myTop');
const myselfRoutes = require('./routes/myself');
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');
const historyRoutes = require('./routes/history');
const gchatRoutes = require('./routes/gchat');
const relationRoutes = require('./routes/relation');
const secureNoteRoutes = require('./routes/secureNote');
const resumeRoutes = require('./routes/resume');
const plannerRoutes = require('./routes/planner');
const messageRoutes = require('./routes/message');
const MessageSetting = require('./models/messageSetting');
const MessageStatus = require('./models/messageStatus');
const { sendMail } = require('./Utils/mailer');

const { setActiveGroup } = require('./middleware');
const { logPageAccess } = require('./middleware');

const MongoStore = require('connect-mongo');

// MongoDB接続設定
const dburl = process.env.DB_URL || 'mongodb://localhost:27017/finance';
// const dburl = process.env.DB_URL;
mongoose.connect(dburl)
    .then(() => {
        console.log('MongoDBコネクションOK！！');
    })
    .catch(err => {
        console.log('MongoDBコネクションエラー！！！');
        console.log(err);
    });

//formのリクエストが来たときにパースしてreq.bodyに入れてくれる
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.engine('ejs', ejsMate);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname,'views'));

//publicディレクトリを静的ファイルとして使える様にする
app.use(express.static(path.join(__dirname,'public')));

// SECRET が空文字や未設定でも落ちないようにガード
const secret = (process.env.SECRET && String(process.env.SECRET).trim()) ? String(process.env.SECRET).trim() : 'mysecret';

//ストアを作成。最新のversionではストアを作成するにはMongoStore.create()を使用する
const store = MongoStore.create({
  mongoUrl: dburl,
  touchAfter: 24 * 60 * 60, // セッションに変更がなければ無駄に保存しないための期間
  // crypto は必須ではないため、まずは外して起動安定化（必要なら後で戻せる）
  serialize: (session) => JSON.stringify(session),
  unserialize: (data) => {
    const ensureCookie = (sess) => {
      if (!sess || typeof sess !== 'object') return { cookie: {} };
      if (!sess.cookie || typeof sess.cookie !== 'object') sess.cookie = {};
      return sess;
    };

    if (!data) return { cookie: {} };
    if (typeof data !== 'string') return ensureCookie(data);
    try {
      return ensureCookie(JSON.parse(data));
    } catch (err) {
      console.warn('⚠️ Invalid session data detected, dropping session:', err.message);
      return { cookie: {} };
    }
  }
});

//セッションのエラー管理
store.on('error',e => {
    console.log('セッションストアーエラー', e);
});

//セッションの設定　作成したstoreをsessionConfigに設定する
const sessionConfig = {
    store, //セッションのオプションにconnect-mongoを設定する
    secret,
    resave: false,
    saveUninitialized: false,
    //cookieの設定
    cookie: {
	    //cookieの有効期限を設定
	    maxAge: 1000 * 60 * 60 *24 * 7,
	    //JavaScriptからcookieの値を取り除いたりして、悪さが出来ないようにする
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
};

app.use(session(sessionConfig));

// Track active service for navigation context.
app.use((req, res, next) => {
  const path = req.path || '';
  if (path.startsWith('/finance') || path.startsWith('/export') || path.startsWith('/asset') || path.startsWith('/matomete')) {
    req.session.activeService = 'finance';
  } else if (path.startsWith('/message')) {
    req.session.activeService = 'message';
  } else if (path.startsWith('/allaboutme') || path.startsWith('/history') || path.startsWith('/relation') || path.startsWith('/resume') || path.startsWith('/myself')) {
    req.session.activeService = 'myself';
  }
  next();
});

// Passport 初期化
app.use(passport.initialize());
app.use(passport.session());

// ✅ EJS 側で ReferenceError を起こさないため、最低限の locals を先に定義しておく
app.use((req, res, next) => {
  res.locals.currentUser = null;
  res.locals.userGroups = [];
  res.locals.activeGroupId = req.session?.activeGroupId || null;
  res.locals.activeService = req.session?.activeService || 'finance';
  res.locals.services = {
    allaboutme: true,
    finance: true,
    assets: true,
    message: true,
  };
  next();
});

//passport-local-mongooseのメソッドを使える様にする
passport.use(new LocalStrategy(FinanceUser.authenticate()));
passport.serializeUser(FinanceUser.serializeUser());
passport.deserializeUser(FinanceUser.deserializeUser());

//flashの設定
//flashの設定
app.use(flash());


// ✅ setActiveGroup を先に適用（req.user を populate する）
app.use(setActiveGroup);

// Alive自動確認（対象サービス利用時）
app.use(async (req, res, next) => {
  try {
    if (!req.user || !req.session?.activeGroupId) return next();

    const setting = await MessageSetting.findOne({
      user: req.user._id,
      group: req.session.activeGroupId,
      service_enabled: true
    });
    if (!setting) return next();

    const status = await MessageStatus.findOne({ user: req.user._id, group: req.session.activeGroupId });
    const now = new Date();
    if (status?.last_alive_at) {
      const last = new Date(status.last_alive_at);
      if (last.toDateString() === now.toDateString()) return next();
    }

    const updated = await MessageStatus.findOneAndUpdate(
      { user: req.user._id, group: req.session.activeGroupId },
      { last_alive_at: now, last_alive_source: 'service', warning_started_at: null, warning_days_sent: 0, pre_notice_sent_at: null, final_sent_at: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (req.user.isMail !== false && req.user.email) {
      const sentAt = updated?.last_alive_notice_sent_at ? new Date(updated.last_alive_notice_sent_at) : null;
      if (!sentAt || sentAt.toDateString() !== now.toDateString()) {
        try {
          await sendMail({
            to: req.user.email,
            subject: '【All About me】Alive確認 完了',
            templateName: 'messageAliveConfirmed',
            templateData: {
              name: req.user.displayname || req.user.username
            }
          });
          await MessageStatus.findOneAndUpdate(
            { user: req.user._id, group: req.session.activeGroupId },
            { last_alive_notice_sent_at: now }
          );
        } catch (err) {
          console.error('Alive確認完了メール送信エラー:', err);
        }
      }
    }
    next();
  } catch (err) {
    console.error('Alive自動更新エラー:', err);
    next();
  }
});

// ✅ res.locals の設定（populate 済みの currentUser を信頼して使う）
app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.activeGroupId = req.session.activeGroupId || null;
    res.locals.activeService = req.session?.activeService || 'finance';
    res.locals.currentPath = req.originalUrl || '';

    // currentUser は常に定義（EJS で ReferenceError を防ぐ）
    res.locals.currentUser = req.user || null;
    res.locals.userGroups = (req.user && Array.isArray(req.user.groups)) ? req.user.groups : [];

    // 🔽 利用可能サービス（ナビメニュー出し分け用）
    if (req.user && req.user.services) {
        res.locals.services = Object.assign(
          { allaboutme: true, finance: true, assets: true, message: true },
          req.user.services
        );
    } else {
        res.locals.services = {
            allaboutme: true,
            finance: true,
            assets: true,
            message: true
        };
    }

    next();
});

//ページアクセスログミドルウェア
app.use((req, res, next) => {
  const excludedPaths = ['/favicon.ico', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.woff', '.woff2', '.ttf'];
  const skip = excludedPaths.some(ext => req.originalUrl.includes(ext));
  if (!skip) {
    return logPageAccess(req, res, next);
  }
  next();
});

//全リクエストを監視するミドルウェアを追加
app.use((req, res, next) => {
    next();
});

app.use((req, res, next) => {
  res.locals.page = null;
  next();
});

//topページへのアクセス
app.get('/', (req, res) => {
  return res.render('common/top'); // views/common/top.ejsにアクセス
});

//RESTfulなルーティング設定
app.get('/finance', (req, res) => {
    res.render('index', { page: 'index' });
});

//ログイン後の/financeへのルーティング
app.use('/finance', financeRoutes);

//ユーザー登録関連のルート作成
app.use('/', userRoutes);

//まとめて入力項目関連のルート作成
app.use('/matomete', matometeRoutes);

//グループ作成関連のルート作成
app.use('/group', groupRoutes);

//資産管理関連のルート作成
app.use('/asset', assetRoutes);

//outputへのルート作成
app.use('/export', outputRoutes);

//manageへのルート作成
app.use('/manage', manageRoutes);

//All About meへのルート
app.use('/allaboutme', allaboutmeRoutes);
app.use('/allaboutme', eventcal2Routes);

//my historyへのルート
app.use('/history', historyRoutes);

//myTopへのルート
app.use('/myTop' , myTopRoutes);
//myselfへのルート
app.use('/myself', myselfRoutes);

//サポートページへのルート
app.use('/support', supportRoutes);

//gchatへのルート
app.use('/gchat', gchatRoutes);

//relationへのルート
app.use('/relation', relationRoutes);

// Google Photos 経由のリダイレクトにも対応させる
app.use('/googlePhotos', googlePhotosRouter);

// Google OAuth endpoints
app.use('/auth/google', googlePhotosRouter);

//adminへのルート
app.use('/admin', adminRoutes);
//セキュアノートへのルート
app.use('/secure-note', secureNoteRoutes);
//resumeへのルート
app.use('/resume', resumeRoutes);
//Plannerへのルート
app.use('/planner', plannerRoutes);
// Message へのルート
app.use('/message', messageRoutes);
// OCR関連のルート
app.use('/ocr', ocrRoutes);

// Chrome DevTools の自動アクセス（ログ抑制）
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.status(204).end();
});

app.all('*',(req,res,next) => {
    // res.send('404');
    //エラークラス(ExpressError.js)を使ってハンドリングするやり方
    //nextを呼んでその中にエラーを入れる
    //エラーの時どうするかはエラーハンドラーに任せる事ができる
    next(new ExpressError('ページが見つかりませんでした',404));
});

//ミドルウェアにカスタムのエラーハンドラーを追加する
//エラーハンドラーにエラーが渡ってくることを想定して
app.use((err, req, res, next) => {
  // すでにレスポンスが返っている場合、ここでヘッダ操作すると ERR_HTTP_HEADERS_SENT になる
  if (res.headersSent) return next(err);

  console.error('❌ Error handler:', err);
  const { statusCode = 500 } = err;
  res.status(statusCode).render('error', { err, showStack: process.env.NODE_ENV !== 'production' });
});

//ポートの設定
const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`ポート${port}でリクエスト待受中....`);
  });
