const path = require('path');
let kuromoji;
try {
  kuromoji = require('kuromoji');
} catch (err) {
  kuromoji = null;
}

const defaultStopwords = new Set([
  'する', 'した', 'して', 'いる', 'ある', 'なる', 'です', 'ます', 'でした', 'ました',
  'これ', 'それ', 'あれ', 'この', 'その', 'あの',
  'ため', 'ので', 'から', 'まで', 'より', 'など', 'もの', 'こと',
  '今日', '昨日', '明日', '一日', '本日',
  '自分', '私', '僕', 'あなた', '彼', '彼女',
  'ない', 'なく', 'よう', 'ので', 'また', 'そして', 'しかし',
  'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'a', 'an'
]);

const tokenize = (text) => {
  if (!text) return [];
  const normalized = String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[“”"'’]/g, '')
    .toLowerCase();
  const matches = normalized.match(/[一-龠々〆ヵヶぁ-んァ-ヴーa-z0-9]+/gi) || [];
  return matches;
};

const isValidToken = (token, stopwords) => {
  if (!token) return false;
  if (stopwords && stopwords.has(token)) return false;
  if (/^[=\\/\\-\\*+]+$/.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^[a-z0-9]+$/i.test(token) && token.length < 3) return false;
  if (/^[一-龠々〆ヵヶぁ-んァ-ヴー]+$/.test(token) && token.length < 2) return false;
  return token.length >= 2;
};

const normalizeToken = (token) => {
  return String(token || '').trim().toLowerCase();
};

const scoreToken = (token, count) => {
  const len = token.length;
  const lengthBoost = len >= 6 ? 1.8 : len >= 4 ? 1.4 : 1;
  return Math.round(count * lengthBoost * 100) / 100;
};

let tokenizerPromise = null;
const getTokenizer = () => {
  if (!kuromoji) return null;
  if (!tokenizerPromise) {
    const dicPath = path.join(__dirname, '../node_modules/kuromoji/dict');
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tokenizer) => {
        if (err) return reject(err);
        resolve(tokenizer);
      });
    });
  }
  return tokenizerPromise;
};

const extractDiaryTags = async (text, options = {}) => {
  const maxTags = Number.isInteger(options.maxTags) ? options.maxTags : 10;
  const excludeWords = Array.isArray(options.excludeWords) ? options.excludeWords : [];
  const normalizedExclude = excludeWords.map(normalizeToken).filter(Boolean);
  const stopwords = new Set([...defaultStopwords, ...normalizedExclude]);
  let tokens = [];

  const tokenizer = await getTokenizer();
  if (tokenizer) {
    const kuromojiTokens = tokenizer.tokenize(text || '');
    tokens = kuromojiTokens
      .filter(t => t && (t.pos === '名詞' || t.pos === '動詞'))
      .map(t => (t.pos === '動詞' && t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form);
  } else {
    tokens = tokenize(text);
  }

  tokens = tokens.map(normalizeToken).filter((t) => isValidToken(t, stopwords));
  const counts = new Map();
  tokens.forEach((t) => {
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, score: count }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxTags);
};

module.exports = { extractDiaryTags };
