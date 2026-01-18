require('dotenv').config();

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { MongoClient, ObjectId } = require('mongodb');

// MongoDB接続設定
// MongoDB接続設定
const dburl = 'mongodb://localhost:27017/finance';
// const dburl = process.env.DB_URL;
const dbName = 'finance';
const collectionName = 'finances';


async function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath, { encoding: 'utf8' })
      .pipe(csv())
      .on('data', (row) => {
        try {
          const parsed = {
            date: new Date(row.date),
            month: parseInt(row.month),
            day: parseInt(row.day),
            cf: row.cf || '',
            income_item: row.income_item || '',
            expense_item: row.expense_item || '',
            dedu_item: row.dedu_item || '',
            content: row.content || '',
            amount: parseFloat(row.amount) || 0,
            payment_type: row.payment_type || '',
            user: new ObjectId(row.user),
            group: new ObjectId(row.group),
            entry_date: new Date(row.entry_date),
            update_date: row.update_date ? new Date(row.update_date) : null
          };
          results.push(parsed);
        } catch (err) {
          console.error('⚠️ パースエラー:', row, err.message);
        }
      })
      .on('end', () => {
        console.log(`📦 CSV読み込み完了: ${results.length}件`);
        resolve(results);
      })
      .on('error', (err) => {
        console.error('🚨 CSV読み込みエラー:', err);
        reject(err);
      });
      
  });
}

async function main() {
  const client = new MongoClient(dburl);
  try {
    await client.connect();
    console.log('✅ MongoDBに接続しました。');

    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    const csvFilePath = path.join(__dirname, 'finance_add_data.csv');
    if (!fs.existsSync(csvFilePath)) {
      console.error('❌ CSVファイルが見つかりません:', csvFilePath);
      return;
    }

    const data = await parseCSV(csvFilePath);
    if (data.length === 0) {
      console.warn('⚠️ 読み込めるデータがありません');
      return;
    }

    const result = await collection.insertMany(data);
    console.log(`✅ ${result.insertedCount}件のデータを挿入しました。`);
    console.log('🧾 insertMany結果:', result);
  } catch (err) {
    console.error('🚨 エラー:', err);
  } finally {
    await client.close();
    console.log('🔌 MongoDB接続を終了しました。');
  }
}

main();