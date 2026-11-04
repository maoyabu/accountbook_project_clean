function resolveFinanceListDisplay(input = {}, defaultSort = 'date') {
  const last = value => Array.isArray(value) ? value.at(-1) : value;
  const requestedSort = last(input.sortOrder);
  const sortOrder = ['date', 'update_date'].includes(requestedSort) ? requestedSort : defaultSort;
  const limit = Number(last(input.limit));
  const displayLimit = [20, 50, 100].includes(limit) ? limit : 20;
  return { sortOrder, displayLimit, sortCriteria: sortOrder === 'update_date' ? { update_date: -1 } : { date: -1 } };
}
module.exports = { resolveFinanceListDisplay };
