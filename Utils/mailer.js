const nodemailer = require('nodemailer');
const ejs = require('ejs');
const path = require('path');


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});


async function sendMail({ to, subject, templateName, templateData }) {
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