const normalizeFiscalStartMonth = (value) => {
  const month = Number(value);
  if (Number.isInteger(month) && month >= 1 && month <= 12) return month;
  return 1;
};

const getFiscalYearForDate = (date, startMonth = 1) => {
  const fiscalStart = normalizeFiscalStartMonth(startMonth);
  const target = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(target.getTime())) return null;
  const year = target.getFullYear();
  const month = target.getMonth() + 1;
  return month >= fiscalStart ? year : year - 1;
};

const getFiscalYearRange = (fiscalYear, startMonth = 1) => {
  const fiscalStart = normalizeFiscalStartMonth(startMonth);
  const start = new Date(fiscalYear, fiscalStart - 1, 1, 0, 0, 0, 0);
  const end = new Date(fiscalYear + 1, fiscalStart - 1, 1, 0, 0, 0, 0);
  const endInclusive = new Date(end.getTime() - 1);
  return { start, end, endInclusive };
};

const getPreviousFiscalYearMeta = (baseDate = new Date(), startMonth = 1) => {
  const currentFiscalYear = getFiscalYearForDate(baseDate, startMonth);
  const year = (currentFiscalYear ?? baseDate.getFullYear()) - 1;
  const { start, end, endInclusive } = getFiscalYearRange(year, startMonth);
  return { year, yearLabel: `${year}年度`, start, end, endInclusive };
};

const getFiscalYearStartDateInCalendarYear = (baseDate = new Date(), startMonth = 1) => {
  const fiscalStart = normalizeFiscalStartMonth(startMonth);
  return new Date(baseDate.getFullYear(), fiscalStart - 1, 1, 0, 0, 0, 0);
};

const getFiscalMonths = (startMonth = 1) => {
  const fiscalStart = normalizeFiscalStartMonth(startMonth);
  return Array.from({ length: 12 }, (_, i) => ((fiscalStart - 1 + i) % 12) + 1);
};

const getFiscalMonthIndex = (month, startMonth = 1) => {
  const fiscalStart = normalizeFiscalStartMonth(startMonth);
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  return (m - fiscalStart + 12) % 12;
};

module.exports = {
  normalizeFiscalStartMonth,
  getFiscalYearForDate,
  getFiscalYearRange,
  getPreviousFiscalYearMeta,
  getFiscalYearStartDateInCalendarYear,
  getFiscalMonths,
  getFiscalMonthIndex
};
