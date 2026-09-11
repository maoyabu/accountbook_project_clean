const crypto = require('crypto');
const { sendMail } = require('./mailer');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function sendRegistrationVerification(user, baseUrl) {
  const token = crypto.randomBytes(32).toString('hex');
  user.emailVerificationToken = hashToken(token);
  user.emailVerificationExpires = new Date(Date.now() + VERIFICATION_TTL_MS);
  await user.save();

  const verifyUrl = `${String(baseUrl).replace(/\/$/, '')}/verify-email/${token}`;
  await sendMail({
    to: user.email,
    subject: '会員登録メールアドレスの確認',
    templateName: 'registrationVerification',
    templateData: { username: user.username, verifyUrl }
  });
}

module.exports = { hashToken, normalizeEmail, sendRegistrationVerification };
