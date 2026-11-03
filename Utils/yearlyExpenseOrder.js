// Category groups arrive in their configured display_order/name order.
function sortYearlyExpenseItems(items, budgets, categoryGroups) {
  const categoryOrder = new Map();
  (categoryGroups || []).forEach((category, index) => {
    (category.item_names || []).forEach(item => {
      if (!categoryOrder.has(item)) categoryOrder.set(item, index);
    });
  });
  const itemOrder = new Map((budgets || []).map(budget => [budget.expense_item, budget.display_order ?? 9999]));
  const unassigned = Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) =>
    (categoryOrder.get(a) ?? unassigned) - (categoryOrder.get(b) ?? unassigned)
    || (itemOrder.get(a) ?? 9999) - (itemOrder.get(b) ?? 9999)
    || a.localeCompare(b, 'ja')
  );
}
function applyYearlyExpenseItemBorders(sheet, rowNumbers) {
  for (const row of rowNumbers) for (let column = 1; column <= sheet.columnCount; column++) {
    const cell = sheet.getCell(row, column);
    if (cell.border?.bottom?.style === 'thick') continue;
    cell.border = { ...cell.border, bottom: { style: 'dotted', color: { argb: 'FF87958B' } } };
  }
}
module.exports = { sortYearlyExpenseItems, applyYearlyExpenseItemBorders };
