// utils/imageUtils.js
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');

async function convertHeicToJpeg(originalPath) {
  try {
    const inputBuffer = await fs.readFile(originalPath);

    // sharp でフォーマットを判定
    const metadata = await sharp(inputBuffer).metadata();
    const format = metadata.format;
    //console.log(`📄 画像フォーマット: ${format}`);

    const ext = path.extname(originalPath).toLowerCase();
    const dir = path.dirname(originalPath);
    const base = path.basename(originalPath, ext);
    const newPath = path.join(dir, `${base}_ocr.jpeg`);

    if (format === 'heic' || format === 'heif') {
      const outputBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.75 });
      await sharp(outputBuffer)
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(newPath);
    } else {
      await sharp(inputBuffer)
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(newPath);
    }
    //console.log('✅ HEIC → JPEG 変換成功:', newPath);
    // 元のHEICファイルを削除
    try {
      await fs.unlink(originalPath);
      console.log('🧹 元のHEICファイルを削除しました:', originalPath);
    } catch (unlinkErr) {
      console.error('❌ 元のHEICファイルの削除に失敗:', unlinkErr);
    }
    return newPath;
  } catch (err) {
    console.error('❌ HEIC変換処理中にエラー:', err);
    return null;
  }
}

module.exports = { convertHeicToJpeg };
