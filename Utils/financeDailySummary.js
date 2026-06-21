const Finance = require('../models/finance');
const FinanceUser = require('../models/users');
const FinanceDailySummaryDelivery = require('../models/finance_daily_summary_delivery');
const { sendMail } = require('./mailer');

const TOKYO_TIME_ZONE = 'Asia/Tokyo';

const getTokyoDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour)
  };
};

const formatDateKey = ({ year, month, day }) => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

const getPreviousTokyoDateKey = (date = new Date()) => {
  const previousDay = new Date(date.getTime() - (24 * 60 * 60 * 1000));
  return formatDateKey(getTokyoDateParts(previousDay));
};

const getEntryItem = (entry) => {
  if (entry.cf === '支出') return entry.expense_item || '';
  if (entry.cf === '収入') return entry.income_item || '';
  if (entry.cf === '控除') return entry.dedu_item || '';
  if (entry.cf === '貯蓄') return entry.saving_item || '';
  return '';
};

const buildSummaryRows = (entries) => entries.map(entry => ({
  groupName: entry.group?.group_name || 'グループ未設定',
  category: entry.cf || '',
  item: getEntryItem(entry),
  content: entry.content || '',
  amount: Number(entry.amount) || 0,
  paymentType: entry.payment_type || ''
}));

const sendFinanceDailySummaries = async ({ now = new Date() } = {}) => {
  const { hour } = getTokyoDateParts(now);
  const summaryDate = getPreviousTokyoDateKey(now);
  const dayStart = new Date(`${summaryDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + (24 * 60 * 60 * 1000));
  const users = await FinanceUser.find({
    financeDailySummaryEnabled: true,
    financeDailySummaryHour: hour,
    isMail: { $ne: false },
    email: { $exists: true, $ne: '' }
  }).select('username displayname email');

  let sentCount = 0;
  for (const user of users) {
    let delivery;
    try {
      delivery = await FinanceDailySummaryDelivery.create({
        user: user._id,
        summaryDate
      });
    } catch (error) {
      if (error?.code === 11000) continue;
      throw error;
    }

    try {
      const entries = await Finance.find({
        user: user._id,
        date: { $gte: dayStart, $lt: dayEnd }
      })
        .populate('group', 'group_name')
        .sort({ entry_date: 1, _id: 1 })
        .lean();
      const rows = buildSummaryRows(entries);
      const expenseTotal = rows
        .filter(row => row.category === '支出')
        .reduce((total, row) => total + row.amount, 0);
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

      await sendMail({
        to: user.email,
        subject: `【家計簿】${summaryDate}の入力サマリー`,
        templateName: 'financeDailySummary',
        templateData: {
          name: user.displayname || user.username,
          summaryDate,
          rows,
          expenseTotal,
          financeUrl: `${baseUrl}/finance/list?date_from=${summaryDate}&date_to=${summaryDate}`
        }
      });
      delivery.sentAt = new Date();
      await delivery.save();
      sentCount += 1;
    } catch (error) {
      await FinanceDailySummaryDelivery.deleteOne({ _id: delivery._id });
      console.error(`Finance daily summary mail error (user=${user._id}, date=${summaryDate}):`, error);
    }
  }

  return { summaryDate, sentCount };
};

module.exports = {
  getTokyoDateParts,
  getPreviousTokyoDateKey,
  buildSummaryRows,
  sendFinanceDailySummaries
};
