const FINANCE_QUICK_MENU_ITEMS = [
  { key: 'group_switch', label: 'グループの切り替え', href: '#', icon: 'fa-users' },
  { key: 'new_entry', label: '新規登録', href: '/finance/entry', icon: 'fa-plus' },
  { key: 'receipt_entry', label: 'レシートから登録', href: '/finance/receipt/new', icon: 'fa-receipt' },
  { key: 'bulk_entry', label: 'まとめて入力', href: '/matomete/regular-entry/push', icon: 'fa-layer-group' },
  { key: 'search', label: '検索', href: '/finance/search', icon: 'fa-magnifying-glass' },
  { key: 'payment_check', label: '月次支払種別チェック', href: '/export/payment-check', icon: 'fa-list-check' },
  { key: 'payment_yearly_summary', label: '年次支払種別集計', href: '/export/payment-summary-yearly', icon: 'fa-table-columns' },
  { key: 'budget_settings', label: '家計簿設定', href: '/finance/budget', icon: 'fa-gear' },
  { key: 'monthly_group', label: '月次集計（グループ）', href: '/export/dashboard/monthly-g', icon: 'fa-chart-line' },
  { key: 'monthly_personal', label: '月次集計（個人）', href: '/export/dashboard/monthly-m', icon: 'fa-user' },
  { key: 'yearly_group', label: '年次集計（グループ）', href: '/export/dashboard/yearly-g', icon: 'fa-chart-line' },
  { key: 'yearly_personal', label: '年次集計（個人）', href: '/export/dashboard/yearly-m', icon: 'fa-user' },
  { key: 'monthly_calendar', label: '月次カレンダー集計', href: '/export/dashboard/monthly-calendar-m', icon: 'fa-calendar-days' },
  { key: 'yearly_group_graph', label: '年グラフ（グループ）', href: '/export/yearly-stacked', icon: 'fa-chart-column' },
  { key: 'monthly_group_graph', label: '月グラフ（グループ）', href: '/export/monthly-stacked', icon: 'fa-chart-column' }
];

const FINANCE_QUICK_MENU_DEFAULT = [{ key: 'new_entry', label: '' }];

const itemByKey = new Map(FINANCE_QUICK_MENU_ITEMS.map((item) => [item.key, item]));

function normalizeQuickMenuItems(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  const cleaned = [];

  rows.forEach((row) => {
    const key = String(row?.key || '').trim();
    if (!itemByKey.has(key) || seen.has(key) || cleaned.length >= 5) return;
    seen.add(key);
    cleaned.push({
      key,
      label: String(row?.label || '').trim().slice(0, 24)
    });
  });

  return cleaned;
}

function buildQuickMenuItems(savedItems) {
  const normalized = normalizeQuickMenuItems(
    Array.isArray(savedItems) && savedItems.length > 0 ? savedItems : FINANCE_QUICK_MENU_DEFAULT
  );

  return normalized.map((saved) => {
    const base = itemByKey.get(saved.key);
    return {
      ...base,
      displayLabel: saved.label || base.label,
      customLabel: saved.label || ''
    };
  });
}

module.exports = {
  FINANCE_QUICK_MENU_ITEMS,
  FINANCE_QUICK_MENU_DEFAULT,
  normalizeQuickMenuItems,
  buildQuickMenuItems
};
