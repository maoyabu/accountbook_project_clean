require('dotenv').config();
const path = require('path');
const fs = require('fs');

// 🔐 Google Cloud 認証情報 (Base64文字列 → .jsonファイルに復元)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64 && process.env.NODE_ENV === 'production') {
  const configDir = path.join(__dirname, 'config');
  const credentialsPath = path.join(configDir, 'accountbook.json');
  
  // configディレクトリが存在しなければ作成
    if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    }

  const decoded = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64, 'base64').toString('utf-8');
  fs.writeFileSync(credentialsPath, decoded);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  console.log('✅ Google 認証情報ファイルを書き出しました');
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

const financeRoutes = require('./routes/finance');
const userRoutes = require('./routes/users');
const outputRoutes = require('./routes/output');
const groupRoutes = require('./routes/groups');
const manageRoutes = require('./routes/manage');
const matometeRoutes = require('./routes/matomete');
const assetRoutes = require('./routes/asset');
const allaboutmeRoutes = require('./routes/allaboutme');
const myTopRoutes = require('./routes/myTop');
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');
const historyRoutes = require('./routes/history');
const gchatRoutes = require('./routes/gchat');
const relationRoutes = require('./routes/relation');
const secureNoteRoutes = require('./routes/secureNote');
const resumeRoutes = require('./routes/resume');
const plannerRoutes = require('./routes/planner');

const flash = require('express-flash');
const { error } = require('console');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const FinanceUser = require('./models/users');
const { setActiveGroup } = require('./middleware');
const { logPageAccess } = require('./middleware'); // ← すでにsetActiveGroupを使っているのでその隣に追記

const googlePhotosRouter = require('./routes/googlePhotos');
const ocrRoutes = require('./routes/ocr');

//MongoStoreとしてrequireする
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

const secret = process.env.SECRET || 'mysecret';

//ストアを作成。最新のversionではストアを作成するにはMongoStore.create()を使用する
const store = MongoStore.create({
    mongoUrl: dburl,
    touchAfter: 24 * 60 * 60,  // セッションに変更がなければ無駄に保存しないための期間
    crypto: {
        secret
    }
});

//セッションのエラー管理
store.on('error',e => {
    console.log('セッションストアーエラー', e);
});

//セッションの設定　作成したstoreをsessionConfigに設定する
sessionConfig = {
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

//passport-local-mongooseのメソッドを使える様にする
passport.use(new LocalStrategy(FinanceUser.authenticate()));
passport.serializeUser(FinanceUser.serializeUser());
passport.deserializeUser(FinanceUser.deserializeUser());

//flashの設定
app.use(flash());

// ✅ setActiveGroup を先に適用（req.user を populate する）
app.use(setActiveGroup);

// ✅ res.locals の設定（populate 済みの currentUser を信頼して使う）
app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.activeGroupId = req.session.activeGroupId || null;

    // currentUser.groups が populate されていない場合は処理しない
    if (req.user && req.user.groups) {
        res.locals.currentUser = req.user;
        res.locals.userGroups = req.user.groups;
    } else {
        res.locals.currentUser = null;
        res.locals.userGroups = [];
    }

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
    res.render('common/top'); // views/common/top.ejsにアクセス
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
app.use((err,req,res,next) => {
    const { statusCode = 500, message = '問題が起きました' } = err;
    res.status(statusCode).render('error', { err, showStack: process.env.NODE_ENV !== 'production' });
});

//ポートの設定
const port = process.env.PORT || 3000;

app.listen(port, () => {
    console.log(`ポート${port}でリクエスト待受中....`);
  });
