const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { correctOcrText } = require('../Utils/gptCorrection');
const vision = require('@google-cloud/vision');
const client = new vision.ImageAnnotatorClient();

async function extractOcrData(imagePath) {
  const [result] = await client.textDetection(imagePath);
  const detections = result.textAnnotations;
  return detections.length ? detections[0].description : '';
}
const OCRLog = require('../models/ocrs');

const upload = multer({
  dest: path.join(__dirname, '../public/uploads/receipts'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|heic|heif)$/i.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error('許可されていないファイル種別です'));
  }
});

// Step 1: OCR image upload and extraction only
router.post('/upload', upload.single('receiptImage'), async (req, res) => {
  try {
    const originalPath = req.file.path;
    const resizedPath = originalPath + '_resized.jpg';

    await sharp(originalPath).resize(1200).jpeg().toFile(resizedPath);
    fs.unlinkSync(originalPath);

    const rawText = await extractOcrData(resizedPath);
    req.session.ocrText = rawText;
    req.session.ocrImagePath = resizedPath;

    res.redirect('/ocr/confirm');
  } catch (err) {
    console.error('OCR upload error:', err);
    res.status(500).send('OCRアップロードに失敗しました');
  }
});

// Step 2: OCR result confirmation and GPT correction
router.get('/confirm', (req, res) => {
  if (!req.session.ocrText) return res.status(400).send('OCRデータが見つかりません');
  res.render('ocr/confirm', { ocrText: req.session.ocrText });
});

router.post('/confirm', async (req, res) => {
  try {
    const rawText = req.session.ocrText;
    if (!rawText) return res.status(400).send('OCRデータがありません');

    const corrected = await correctOcrText(rawText);

    await OCRLog.create({
      content: rawText,
      extracted: {
        storeName: corrected.storeName,
        amount: corrected.amount,
        date: corrected.date
      },
      corrected: {
        storeName: corrected.storeName,
        amount: corrected.amount,
        date: corrected.date,
        tags: corrected.tags
      }
    });

    // 変換済み画像の掃除
    try {
      const tmpPath = req.session.ocrImagePath;
      if (tmpPath && fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (e) {
      // no-op cleanup failure
    }
    delete req.session.ocrText;
    delete req.session.ocrImagePath;

    res.render('ocr/result', { result: corrected });
  } catch (err) {
    console.error('GPT補正エラー:', err);
    res.status(500).send('GPT補正に失敗しました');
  }
});

module.exports = router;
