console.log('index.js start');
// 起動デバッグ用（どこで止まっているかを特定）
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});
console.log('[boot] 1: before dotenv');
require('dotenv').config();
console.log('[boot] 2: after dotenv');
const path = require('path');
const fs = require('fs');
console.log('[boot] 3: after core requires (path/fs)');

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
console.log('[boot] 4: before express require');
const express = require('express');
console.log('[boot] 5: after express require');
const app = express();
console.log('[boot] 6: after app init');

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
console.log('[boot] 7: before mongoose require');
const mongoose = require('mongoose');
console.log('[boot] 8: after mongoose require');
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

console.log('[boot] 9: before loading local routes');
const financeRoutes = require('./routes/finance');
console.log('[boot] 9.1: loaded routes/finance');
const userRoutes = require('./routes/users');
console.log('[boot] 9.2: loaded routes/users');
const outputRoutes = require('./routes/output');
console.log('[boot] 9.3: loaded routes/output');
const groupRoutes = require('./routes/groups');
console.log('[boot] 9.4: loaded routes/groups');
const manageRoutes = require('./routes/manage');
console.log('[boot] 9.5: loaded routes/manage');
const matometeRoutes = require('./routes/matomete');
console.log('[boot] 9.6: loaded routes/matomete');
const assetRoutes = require('./routes/asset');
console.log('[boot] 9.7: loaded routes/asset');
const allaboutmeRoutes = require('./routes/allaboutme');
console.log('[boot] 9.8: loaded routes/allaboutme');
const myTopRoutes = require('./routes/myTop');
console.log('[boot] 9.9: loaded routes/myTop');
const adminRoutes = require('./routes/admin');
console.log('[boot] 9.10: loaded routes/admin');
const supportRoutes = require('./routes/support');
console.log('[boot] 9.11: loaded routes/support');
const historyRoutes = require('./routes/history');
console.log('[boot] 9.12: loaded routes/history');
const gchatRoutes = require('./routes/gchat');
console.log('[boot] 9.13: loaded routes/gchat');
const relationRoutes = require('./routes/relation');
console.log('[boot] 9.14: loaded routes/relation');
const secureNoteRoutes = require('./routes/secureNote');
console.log('[boot] 9.15: loaded routes/secureNote');
const resumeRoutes = require('./routes/resume');
console.log('[boot] 9.16: loaded routes/resume');
const plannerRoutes = require('./routes/planner');
console.log('[boot] 9.17: loaded routes/planner');

console.log('[boot] 10: before loading middleware');
const { setActiveGroup } = require('./middleware');
console.log('[boot] 10.1: loaded middleware.setActiveGroup');
const { logPageAccess } = require('./middleware');
console.log('[boot] 10.2: loaded middleware.logPageAccess');

console.log('[boot] 11: before connect-mongo require');
const MongoStore = require('connect-mongo');
console.log('[boot] 12: after connect-mongo require');

// MongoDB接続設定
const dburl = process.env.DB_URL || 'mongodb://localhost:27017/finance';
// const dburl = process.env.DB_URL;
console.log('[boot] 13: before mongoose.connect', dburl);
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
    if (!data) return null;
    if (typeof data !== 'string') return data;
    try {
      return JSON.parse(data);
    } catch (err) {
      console.warn('⚠️ Invalid session data detected, dropping session:', err.message);
      return null;
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

// Passport 初期化
app.use(passport.initialize());
app.use(passport.session());

// ✅ EJS 側で ReferenceError を起こさないため、最低限の locals を先に定義しておく
app.use((req, res, next) => {
  res.locals.currentUser = null;
  res.locals.userGroups = [];
  res.locals.activeGroupId = req.session?.activeGroupId || null;
  res.locals.services = {
    allaboutme: true,
    finance: true,
    assets: true,
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

// ✅ res.locals の設定（populate 済みの currentUser を信頼して使う）
app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.activeGroupId = req.session.activeGroupId || null;

    // currentUser は常に定義（EJS で ReferenceError を防ぐ）
    res.locals.currentUser = req.user || null;
    res.locals.userGroups = (req.user && Array.isArray(req.user.groups)) ? req.user.groups : [];

    // 🔽 利用可能サービス（ナビメニュー出し分け用）
    if (req.user && req.user.services) {
        res.locals.services = req.user.services;
    } else {
        res.locals.services = {
            allaboutme: true,
            finance: true,
            assets: true
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

//my historyへのルート
app.use('/history', historyRoutes);

//myTopへのルート
app.use('/myTop' , myTopRoutes);

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
// OCR関連のルート
app.use('/ocr', ocrRoutes);

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

console.log('[boot] 99: about to listen');
app.listen(port, () => {
    console.log(`ポート${port}でリクエスト待受中....`);
  });

console.log('index.js end');
