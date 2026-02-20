// routes/api/apiSupport.js
const express = require('express');
const router = express.Router();
const Qa = require('../../models/qa');
const Inquiry = require('../../models/inquiry');
const PublicInquiry = require('../../models/publicInquiry');
const { sendMail } = require('../../Utils/mailer');

// 共通ログ
router.use((req, res, next) => {
  next();
});

// 認証チェック（セッション前提）
function requireLogin(req, res, next) {
  if (req.user && req.user._id) return next();
  return res.status(401).json({ error: 'unauthorized', message: 'ログインが必要です' });
}

// GET /api/support/public/faq?faq_flag=true
router.get('/public/faq', async (req, res, next) => {
  try {
    const flagRaw = String(req.query.faq_flag ?? '').trim().toLowerCase();
    let faqFlag = true;
    if (flagRaw) {
      faqFlag = ['true', '1', 'yes'].includes(flagRaw);
    }

    const qas = await Qa.find({ faq_flag: faqFlag })
      .select('qa_category qa_question qa_answer url')
      .sort({ update_date: -1 })
      .lean();

    const result = qas.map(item => ({
      _id: String(item._id),
      qa_category: item.qa_category || '',
      qa_question: item.qa_question || '',
      qa_answer: item.qa_answer || '',
      url: item.url || null
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/support/public/inquiries
router.post('/public/inquiries', async (req, res, next) => {
  try {
    const { email, title, message } = req.body;

    if (!email || !title || !message) {
      return res.status(400).json({ error: 'missing_params', message: 'email, title, message は必須です' });
    }

    const inquiry = await PublicInquiry.create({
      email,
      title,
      message
    });

    const toEmail = process.env.ADMIN_NOTIFY_EMAIL || 'ma.oyabu@gmail.com';
    await sendMail({
      to: toEmail,
      subject: `[お問い合わせ] ${title}`,
      templateName: 'otoiawaseAsk',
      templateData: {
        email,
        subject: title,
        message
      }
    });

    res.json({ ok: true, id: String(inquiry._id) });
  } catch (err) {
    next(err);
  }
});

router.use(requireLogin);

// GET /api/support?faq_flag=true
router.get('/', async (req, res, next) => {
  try {
    const flagRaw = String(req.query.faq_flag ?? '').trim().toLowerCase();
    let faqFlag = true;
    if (flagRaw) {
      faqFlag = ['true', '1', 'yes'].includes(flagRaw);
    }

    const qas = await Qa.find({ faq_flag: faqFlag })
      .select('qa_category qa_question qa_answer url')
      .sort({ update_date: -1 })
      .lean();

    const result = qas.map(item => ({
      _id: String(item._id),
      qa_category: item.qa_category || '',
      qa_question: item.qa_question || '',
      qa_answer: item.qa_answer || '',
      url: item.url || null
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/support/inquiries
router.get('/inquiries', async (req, res, next) => {
  try {
    const inquiries = await Inquiry.find({ user: req.user._id })
      .sort({ update_date: -1 })
      .lean();

    const result = inquiries.map(inq => ({
      _id: String(inq._id),
      title: inq.title || '',
      status: inq.status || 'open',
      closed: Boolean(inq.closed),
      entry_date: inq.entry_date,
      update_date: inq.update_date,
      messages: (inq.messages || []).map(msg => ({
        _id: String(msg._id),
        content: msg.content || '',
        sender: String(msg.sender || ''),
        isAdmin: Boolean(msg.isAdmin),
        mail_delivery: Boolean(msg.mail_delivery),
        mail_sent: Boolean(msg.mail_sent),
        isRead: Boolean(msg.isRead),
        entry_date: msg.entry_date,
        update_date: msg.update_date
      }))
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/support/inquiries
router.post('/inquiries', async (req, res, next) => {
  try {
    const { title, message, email } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'missing_params', message: 'title と message は必須です' });
    }

    const inquiry = await Inquiry.create({
      title: title,
      user: req.user._id,
      messages: [{
        content: message,
        sender: req.user._id,
        isAdmin: false,
        mail_delivery: true,
        mail_sent: false,
        isRead: true
      }]
    });

    const toEmail = process.env.ADMIN_NOTIFY_EMAIL || 'ma.oyabu@gmail.com';
    await sendMail({
      to: toEmail,
      subject: `[お問い合わせ] ${title}`,
      templateName: 'otoiawaseAsk',
      templateData: {
        email: email || req.user?.email || '未ログイン',
        subject: title,
        message: message
      }
    });

    await Inquiry.findByIdAndUpdate(inquiry._id, {
      $set: { 'messages.0.mail_sent': true }
    });

    res.json({ ok: true, id: String(inquiry._id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/support/inquiries/:id/reply
router.post('/inquiries/:id/reply', async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'missing_params', message: 'message は必須です' });
    }

    const inquiry = await Inquiry.findOne({ _id: req.params.id, user: req.user._id });
    if (!inquiry) {
      return res.status(404).json({ error: 'not_found', message: 'お問い合わせが見つかりません' });
    }

    inquiry.messages.push({
      content: message,
      sender: req.user._id,
      isAdmin: false,
      mail_delivery: true,
      mail_sent: false,
      isRead: true,
      entry_date: new Date()
    });
    await inquiry.save();

    const toEmail = process.env.ADMIN_NOTIFY_EMAIL || 'ma.oyabu@gmail.com';
    await sendMail({
      to: toEmail,
      subject: `[再返信] ${inquiry.title}`,
      templateName: 'otoiawaseAsk',
      templateData: {
        name: req.user?.username || req.user?.displayname || '未登録ユーザー',
        email: req.user?.email || '未ログイン',
        subject: `[再返信] ${inquiry.title}`,
        message: message,
        url: process.env.BASE_URL || 'http://localhost:3000'
      }
    });

    const lastIndex = inquiry.messages.length - 1;
    if (lastIndex >= 0) {
      await Inquiry.findByIdAndUpdate(inquiry._id, {
        $set: { [`messages.${lastIndex}.mail_sent`]: true }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/support/inquiries/:id
router.delete('/inquiries/:id', async (req, res, next) => {
  try {
    const inquiry = await Inquiry.findOne({ _id: req.params.id, user: req.user._id });
    if (!inquiry) {
      return res.status(404).json({ error: 'not_found', message: 'お問い合わせが見つかりません' });
    }

    await Inquiry.deleteOne({ _id: inquiry._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
