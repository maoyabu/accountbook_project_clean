const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const FinanceUser = require('../models/users');
const fs = require('fs');
const Finance = require('../models/finance');
const moment = require('moment');
const path = require('path');
const { sendMail } = require('../Utils/mailer');

//　メール送信者の定義
const url = process.env.BASE_URL;

//1週間以上入力が無いと、リマインドメールを送る
const dayjs = require('dayjs');

// ユーザーごとに最後の入力日を調べてリマインド
async function sendInactivityReminders() {
  const users = await FinanceUser.find({});

  for (const user of users) {
    if (user.isMail === false) continue;
    const latestEntry = await Finance.findOne({ user: user._id })
      .sort({ date: -1 }); // 最新の日付を取得

    const lastDate = latestEntry?.date;
    const today = dayjs();
    const diff = lastDate ? today.diff(dayjs(lastDate), 'day') : Infinity;

    if (diff >= 7) {
      await sendMail({
        to: user.email,
        subject: `【家計簿入力のご案内】${user.displayname}さん、最近の入力はお済みですか？`,
        templateName: 'aweekReminder',
        templateData: {
          displayname: user.displayname,
          diff,
          url: process.env.BASE_URL
        }      });

      console.log(`✅ ${user.displayname} さんにリマインド送信（${diff}日ぶり）`);
    }
  }
}
//メールを送るのは毎日朝8時
cron.schedule('0 8 * * *', () => {
  console.log('⏰ 毎日の未入力チェックを開始');
  sendInactivityReminders();
}, {
  timezone: 'Asia/Tokyo'
});


//「まとめて入力」のリマインドメールを送る
const sendReminders = async () => {
    try {
      const users = await FinanceUser.find({});
  
      for (const user of users) {
        if (user.isMail === false) continue;
        if (!user.email) continue;
  
        await sendMail({
          to: user.email,
          subject: `【リマインダー】${user.displayname}さん、${new Date().getMonth()}月分のまとめて入力をお忘れ無く！`,
          templateName: 'matometeReminder',
          templateData: {
            displayname: user.displayname,
            month: new Date().getMonth(),
            url
          }        });
  
        console.log(`✅ ${user.username} にメール送信済み`);
      }
    } catch (err) {
      console.error('❌ リマインダー送信エラー:', err);
    }
  };

//cronを使って定期作業のスケジューリング
  // 「まとめて入力」　毎月1日 AM9:00 に実行
  cron.schedule('0 9 1 * *', () => {
    sendReminders();
  }, {
    timezone: 'Asia/Tokyo'
  });

const enableDriveBackup = process.env.ENABLE_DRIVE_BACKUP === 'true';
const folderId = '1-V9mDw7x_186mMT2RxWAkxJVFACRfgnT';

async function backupToDrive() {
    if (!enableDriveBackup) {
      console.warn('⚠️ Google Driveバックアップは無効化されています (ENABLE_DRIVE_BACKUP!=true)');
      return;
    }

    let drive;
    try {
      const { google } = require('googleapis');
      const auth = new google.auth.GoogleAuth({
        keyFile: 'credentials.json',
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });
      drive = google.drive({ version: 'v3', auth });
    } catch (err) {
      console.error('❌ Google Drive クライアント初期化失敗:', err);
      return;
    }

    fs.mkdirSync('./backup', { recursive: true }); // ← フォルダがなければ作成

  const data = await Finance.find({}).lean();
  const filePath = './backup/finance_backup.json';
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // Google Driveにアップロード（同じ名前のファイルを検索→更新 or 新規作成）
  const fileName = 'finance_backup.json';

  // 既存ファイルがあるか検索
  const existingFiles = await drive.files.list({
    q: `'${folderId}' in parents and name='finance_backup.json' and trashed=false`,
    fields: 'files(id, name)'
  });

  if (existingFiles.data.files.length > 0) {
    const fileId = existingFiles.data.files[0].id;
    await drive.files.update({
      fileId,
      media: {
        mimeType: 'application/json',
        body: fs.createReadStream(filePath)
      }
    });
    console.log('✅ 上書きアップロード完了');
  } else {
    await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'application/json',
        parents: [folderId]
      },
      media: {
        mimeType: 'application/json',
        body: fs.createReadStream(filePath)
      }
    });
    console.log('✅ 新規アップロード完了');
  }
}

if (enableDriveBackup) {
  cron.schedule('0 9 * * 1', () => {
      console.log('⏰ 毎週のバックアップ実行');
      backupToDrive();
    });
}


// 月次バックアップ: 1日 4:00AM ローカル保存
cron.schedule('0 4 1 * *', async () => {
  console.log('⏰ 月次バックアップをローカルに保存開始');
  const timestamp = moment().format('YYYYMMDD');
  const serial = '001';
  const fileName = `backup_${timestamp}_${serial}.zip`;
    const tempDir = path.join(__dirname, '../backup');
  const zipPath = path.join(tempDir, fileName);

  fs.mkdirSync(tempDir, { recursive: true });

  const modelsPath = path.join(__dirname, '../models');
  const modelFiles = fs.readdirSync(modelsPath).filter(file => file.endsWith('.js') && file !== 'index.js');

  const modelData = {};
  for (const file of modelFiles) {
    const modelName = path.basename(file, '.js');
    try {
      const model = require(`../models/${modelName}`);
      if (typeof model.find === 'function') {
        modelData[modelName] = await model.find({});
      }
    } catch (e) {
      console.warn(`🟡 モデル ${modelName} の取得に失敗:`, e.message);
    }
  }

  for (const [name, data] of Object.entries(modelData)) {
    fs.writeFileSync(`${tempDir}/${name}.json`, JSON.stringify(data, null, 2));
  }

  const output = fs.createWriteStream(zipPath);
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);
  const files = fs.readdirSync(tempDir).filter(file => file.endsWith('.json'));
  for (const file of files) {
    archive.file(path.join(tempDir, file), { name: file });
  }

  archive.finalize();

  output.on('close', () => {
    console.log(`✅ 月次バックアップ完了 (${fileName}, ${archive.pointer()} bytes)`);
  });

  archive.on('error', err => {
    console.error('❌ ZIP作成エラー:', err);
  });
}, {
  timezone: 'Asia/Tokyo'
});

module.exports = router;
