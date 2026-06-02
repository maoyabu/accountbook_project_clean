const mongoose = require('mongoose');
const Info = require('../models/info');
const Group = require('../models/groups');
const FinanceUser = require('../models/users');
const { sendMail } = require('./mailer');

const toDateOrNull = (value) => {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const buildInfoDateQuery = (now = new Date()) => ({
  $and: [
    { $or: [{ from_date: { $exists: false } }, { from_date: null }, { from_date: { $lte: now } }] },
    { $or: [{ end_date: { $exists: false } }, { end_date: null }, { end_date: { $gte: now } }] }
  ]
});

const buildInfoTargetQuery = (groupId) => {
  const clauses = [{ pub_target: 'all' }];
  if (groupId && mongoose.Types.ObjectId.isValid(groupId)) {
    clauses.push(
      { pub_target: groupId.toString() },
      { target_group: new mongoose.Types.ObjectId(groupId) }
    );
  }
  return { $or: clauses };
};

async function fetchPublishedInfosForGroup(groupId, now = new Date()) {
  return Info.find({
    ...buildInfoTargetQuery(groupId),
    ...buildInfoDateQuery(now)
  })
    .sort({ from_date: -1, entry_date: -1 })
    .lean();
}

async function getInfoRecipientEmails(info) {
  const emailSet = new Set();
  const addEmail = (user) => {
    if (user?.email && user.isMail !== false) emailSet.add(user.email);
  };

  const targetGroupId = info.target_group || (info.pub_target !== 'all' ? info.pub_target : null);
  if (targetGroupId && mongoose.Types.ObjectId.isValid(targetGroupId)) {
    const group = await Group.findById(targetGroupId)
      .populate('createdBy', 'email isMail')
      .populate('members', 'email isMail');
    addEmail(group?.createdBy);
    (group?.members || []).forEach(addEmail);
    return Array.from(emailSet);
  }

  const users = await FinanceUser.find({ isMail: { $ne: false }, email: { $exists: true, $ne: '' } })
    .select('email')
    .lean();
  users.forEach(addEmail);
  return Array.from(emailSet);
}

async function deliverInfoMail(info) {
  if (info.mail_delivery === false || info.mail_sent === true) {
    return { sent: false, recipients: 0, reason: info.mail_delivery === false ? 'delivery_disabled' : 'already_sent' };
  }

  const recipients = await getInfoRecipientEmails(info);
  if (recipients.length === 0) {
    return { sent: false, recipients: 0, reason: 'no_recipients' };
  }

  await sendMail({
    to: recipients,
    subject: `【All About me】${info.info_title}`,
    templateName: 'infoNotice',
    templateData: {
      title: info.info_title,
      content: info.info_content || '',
      appUrl: info.app_url || '',
      guideUrl: info.guide_url || '',
      baseUrl: process.env.BASE_URL || ''
    }
  });

  await Info.findByIdAndUpdate(info._id, { mail_sent: true });
  return { sent: true, recipients: recipients.length };
}

module.exports = {
  toDateOrNull,
  fetchPublishedInfosForGroup,
  deliverInfoMail
};
