const express = require('express');
const router = express.Router();
const Inquiry = require('../models/inquiry');
const { isLoggedIn } = require('../middleware');
const Qa = require('../models/qa');
const { sendMail } = require('../Utils/mailer');


//ユーザーのSupportページの表示（未ログインは公開ビュー）
router.get('/', async (req, res) => {
  const faqs = await Qa.find({ faq_flag: true }).sort({ update_date: -1 });

  if (!req.user) {
    return res.render('common/support', {
      user: null,
      inquiries: [],
      hasNewReply: false,
      faqs
    });
  }

  const inquiries = await Inquiry.find({ user: req.user._id }).sort({ entry_date: -1 });

  // お知らせ表示フラグ：未読の管理者返信があるか
  const hasNewReply = inquiries.some(inq =>
    inq.messages.some(msg => msg.isAdmin && msg.mail_sent && !msg.isRead)
  );

  res.render('common/support', {
    user: req.user,
    inquiries,
    hasNewReply,
    faqs
  });
});

// お問合せフォーム送信処理
router.post('/contact', isLoggedIn, async (req, res) => {
    const { email, subject, message } = req.body;
    let inquiry;

    if (!email || !subject || !message) {
      req.flash('error', '全ての項目を入力してください');
      return res.redirect('/support');
    }

    try {

        if (req.user) {
        inquiry = await Inquiry.create({
            title: subject,
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
        // console.log('📝 保存完了 ID:', inquiry._id);
        } else {
        // console.log('⚠️ ログインしていないためDBには保存しません');
        }

      await sendMail({
        to: 'ma.oyabu@gmail.com',
        subject: `[お問い合わせ] ${subject}`,
        templateName: 'otoiawaseAsk',
        templateData: {
          email: email || req.user?.email || '未ログイン',
          subject,
          message: message,
        }
      });

      if (inquiry) {
        await Inquiry.findByIdAndUpdate(inquiry._id, {
          $set: { 'messages.0.mail_sent': true }
        });
      }

      req.flash('success', 'お問い合わせ内容を送信しました。');
      res.redirect('/support');
    } catch (err) {
      console.error('❌ お問い合わせ送信エラー:', err);
      req.flash('error', '送信中にエラーが発生しました。');
      res.redirect('/support');
    }
  });

//返信のあったお問合せにさらに追加の問合せする
router.post('/reply/:id', isLoggedIn, async (req, res) => {
    // console.log('📩 /support/reply にPOSTされました');
    // console.log('ID:', req.params.id);
  const { replyContent } = req.body;
  const inquiry = await Inquiry.findById(req.params.id);
  if (!inquiry) {
    req.flash('error', 'お問い合わせが見つかりません');
    return res.redirect('/support');
  }

  inquiry.messages.push({
    content: replyContent,
    sender: req.user._id,
    isAdmin: false,
    mail_delivery: true,
    mail_sent: false,
    isRead: true,
    entry_date: new Date()
  });
  await inquiry.save();

// 管理者へメール通知
await sendMail({
  to: process.env.ADMIN_NOTIFY_EMAIL,
  subject: `[再返信] ${inquiry.title}`,
  templateName: 'otoiawaseAsk',
  templateData: {
    name: req.user?.username || req.user?.displayname || '未登録ユーザー',
    email: req.user?.email || '未ログイン',
    subject: `[再返信] ${inquiry.title}`,
    message: replyContent,
    url: process.env.BASE_URL || 'http://localhost:3000'
  }
});

  req.flash('success', '返信を送信しました');
  res.redirect('/support');
});


// Q&Aページ表示
router.get('/qa', async (req, res) => {
  const categories = ['サービス全般', '会員について', 'All About me', '家計簿', '資産管理', 'その他'];
  const selectedCategory = req.query.category || '';

  let qas;
  if (selectedCategory) {
    qas = await Qa.find({ qa_category: selectedCategory }).sort({ update_date: -1 });
  } else {
    qas = await Qa.find().sort({ update_date: -1 });
  }

  res.render('common/qa', {
    qas,
    categories,
    selectedCategory
  });
});

// 管理者からの返信を既読としてマーク
// router.post('/mark-read/:id', isLoggedIn, async (req, res) => {
//   try {
//     const inquiry = await Inquiry.findById(req.params.id);
//     if (!inquiry) {
//       return res.status(404).json({ success: false, message: 'Inquiry not found' });
//     }

//     let updated = false;

//     inquiry.messages.forEach(msg => {
//       if (msg.isAdmin && msg.mail_sent && !msg.isRead) {
//         msg.isRead = true;
//         updated = true;
//       }
//     });

//     if (updated) {
//       await inquiry.save();
//     }

//     res.json({ success: true });
//   } catch (error) {
//     console.error('Error marking messages as read:', error);
//     res.status(500).json({ success: false, message: 'Internal Server Error' });
//   }
// });

// 最後の管理者メッセージを既読にする（改修: 本当に最後のメッセージのみ判定）
router.post('/mark-last-admin-read', isLoggedIn, async (req, res) => {
  try {
    const inquiry = await Inquiry.findOne({ user: req.user._id }).sort({ update_date: -1 });
    if (!inquiry) {
      return res.status(404).json({ success: false, message: 'Inquiry not found' });
    }

    const messages = inquiry.messages || [];
    const lastMessage = messages[messages.length - 1];

    if (lastMessage && lastMessage.isAdmin && !lastMessage.isRead) {
      lastMessage.isRead = true;
      await inquiry.save();
      return res.json({ success: true });
    }

    res.json({ success: false, message: 'No unread admin message to mark as read' });
  } catch (error) {
    console.error('Error marking last admin message as read:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

module.exports = router;
