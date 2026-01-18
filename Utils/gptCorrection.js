// Utils/gptCorrection.js

const { OpenAI } = require("openai");
const path = require('path');
const categoryDictionary = require(path.join(__dirname, 'categoryDictionary.json'));

let openai;
function getOpenAI() {
  if (openai) return openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('⚠️ OPENAI_API_KEY が設定されていないため GPT 補正をスキップします');
    return null;
  }
  openai = new OpenAI({ apiKey: key });
  return openai;
}

async function correctOcrText(text) {
  const client = getOpenAI();
  if (!client) return null;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `あなたはレシートのOCR結果から以下の情報を抽出してJSON形式で返すアシスタントです。
必要な情報は、店舗名（storeName）、合計金額（amount）、日付（date）、および購入明細のタグ（tags）です。
JSONフォーマットは次のようにしてください：

{
  storeName: string,
  amount: number,
  date: "YYYY/MM/DD",
  tags: [
    { name: string, category: string, price: number },
    ...
  ]
}

次の18の分類の中から、カテゴリを必ず1つだけ選んでください（カテゴリ名は以下と厳密に一致させてください）:
- 副食物費
- 主食費1
- 主食費2
- 調味料
- 光熱費
- 住宅・家具費
- 衣服費
- 教育費
- 交際費
- 教養費
- 娯楽費
- 保険・衛生費
- 職業費
- 特別費
- 公共費
- 車関連費
- 通信費
- 外税

【重要】
- categoryは自由な語句にせず、上記18分類のいずれかに必ず一致させて
- たとえば「食品」ではなく「副食物費」、「通信料」ではなく「通信費」などに変換して
- 内税と記述が無い場合は全て外税となります。内税の場合は、tagsの中にはそのままの金額を入れて
- 外税の場合は外税の金額をtagsの中に入れて
以下一例：
入力：レシート：
・ミネラルウォーター 100円
・外税10% 10円
合計：110円

出力：
{
  storeName: "サンプル",
  amount: 55,
  date: "2025/06/15",
  tags: [
    { name: "ミネラルウォーター", category: "副食物費", price: 50 },
    { name: "外税", category: "外税", price: 5 }
  ]

- dateは必ずYYYY/MM/DD形式で返してください。
- tagsが見つからない場合は空の配列（[]）にしてください。`
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.2,
    });

    const raw = response.choices[0].message.content.trim();

    // 🔍 JSONブロックだけ抽出（```json ... ```が含まれているケース対応）
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonString = match ? match[1] : raw;

    const parsed = JSON.parse(jsonString);

    // console.log("📦 GPT抽出内容:", parsed);

    // --- ここを修正 ---
    // タグの正規化: categoryを辞書で置換（なければGPTのまま）、priceは数値化
    parsed.tags = Array.isArray(parsed.tags)
      ? parsed.tags.map(t => ({
          name: t.name,
          price: Number(t.price) || 0,
          gptCategory: t.category,
          category: categoryDictionary[t.category] || t.category // 辞書にあれば置換、なければGPTのまま
        }))
      : [];

    // 確実に必要項目が存在するか確認
    if (!parsed.storeName || typeof parsed.amount === 'undefined' || !parsed.date || !parsed.tags) {
      // amount は数値なので、typeof parsed.amount === 'number' とするか、
      // 厳密なチェックが不要なら typeof parsed.amount === 'undefined' 以外で良い
      throw new Error("必要なフィールドが欠落しています");
    }

    return parsed;
  } catch (err) {
    console.error("GPT補正エラー:", err);
    return null;
  }
}

module.exports = { correctOcrText };
