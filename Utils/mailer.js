const nodemailer = require('nodemailer');
const ejs = require('ejs');
const path = require('path');
const mongoose = require('mongoose');


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});


const templateService = {
  diaryReminder: ['allaboutme', 'diaryReminder'],
  planner_request: ['allaboutme', 'planner_request'], planner_yes: ['allaboutme', 'planner_yes'], planner_no: ['allaboutme', 'planner_no'], infoNotice: ['allaboutme', 'infoNotice'], otoiawaseRes: ['allaboutme', 'otoiawaseRes'],
  financeDailySummary: ['finance', 'financeDailySummary'], fiscalBudgetSetupNotice: ['finance', 'fiscalBudgetSetupNotice'], budgetNotice: ['finance', 'budgetNotice'], financeCloseNotice: ['finance', 'financeCloseNotice'], financeYearCloseNotice: ['finance', 'financeYearCloseNotice'], aweekReminder: ['finance', 'aweekReminder'], matometeReminder: ['finance', 'matometeReminder'], matometeNag: ['finance', 'matometeNag'],
  equipmentInventoryReminder: ['assets', 'equipmentInventoryReminder'], purchaseReminder: ['assets', 'purchaseReminder'],
  messageAliveConfirmed: ['message', 'messageAliveConfirmed'], messageAliveCheck: ['message', 'messageAliveCheck'], messagePreNotice: ['message', 'messagePreNotice'], messageWarning: ['message', 'messageWarning'], messageFinal: ['message', 'messageFinal'], messageFinalPassword: ['message', 'messageFinalPassword']
};

async function isEnabled(address, templateName) {
  const target = templateService[templateName];
  if (!target || !mongoose.connection?.readyState || !address) return true;
  const user = await mongoose.connection.collection('users').findOne({ email: String(address).trim().toLowerCase() }, { projection: { isMail: 1, serviceMailPreferences: 1 } });
  if (!user) return true;
  if (user.isMail === false) return false;
  const preference = user.serviceMailPreferences?.[target[0]];
  if (preference === false) return false;
  if (preference && typeof preference === 'object') return preference.enabled !== false && preference.emails?.[target[1]] !== false;
  return true;
}

async function sendMail({ to, subject, templateName, templateData }) {
  if (!await isEnabled(to, templateName)) return { skipped: true, reason: 'service-mail-disabled' };
  const templatePath = path.normalize(path.join(__dirname, 'templates', `${templateName}.ejs`));
  const html = await ejs.renderFile(templatePath, templateData);

  const mailOptions = {
    from: process.env.MAIL_USER,
    to,
    subject,
    html
  };

  return transporter.sendMail(mailOptions);
}

module.exports = { sendMail };