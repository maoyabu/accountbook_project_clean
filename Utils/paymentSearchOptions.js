// Group labels by owner; submitted values remain the stored payment type only.
function buildPaymentSearchOptions(paymentItems, values, currentUserId) {
  const allowed = values ? new Set(values) : null;
  const currentId = String(currentUserId || '');
  const entries = (paymentItems || []).filter(item => item.paymentItem && (!allowed || allowed.has(item.paymentItem))).map(item => {
    const userId = String(item.user?._id || (typeof item.user === 'string' ? item.user : '') || '');
    const name = item.user?.displayname || item.user?.username || '';
    return { value: item.paymentItem, userId, name, ownerKey: userId || name,
      order: typeof item.display_order === 'number' && Number.isFinite(item.display_order) ? item.display_order : Number.MAX_SAFE_INTEGER };
  });
  entries.sort((a, b) => {
    const ownA = currentId && a.userId === currentId ? 0 : 1;
    const ownB = currentId && b.userId === currentId ? 0 : 1;
    return ownA - ownB || a.name.localeCompare(b.name, 'ja') || a.ownerKey.localeCompare(b.ownerKey)
      || a.order - b.order || a.value.localeCompare(b.value, 'ja');
  });
  const options = allowed?.has('Please Choice') ? [{ value: 'Please Choice', label: 'すべて' }] : [];
  const seenByOwner = new Map(), represented = new Set();
  for (const entry of entries) {
    if (entry.value === 'Please Choice') continue;
    if (!seenByOwner.has(entry.ownerKey)) seenByOwner.set(entry.ownerKey, new Set());
    const seen = seenByOwner.get(entry.ownerKey);
    if (seen.has(entry.value)) continue;
    seen.add(entry.value); represented.add(entry.value);
    options.push({ value: entry.value, label: entry.name ? `${entry.value}（${entry.name}）` : entry.value });
  }
  for (const value of allowed || []) if (value !== 'Please Choice' && !represented.has(value)) options.push({ value, label: value });
  return options;
}
module.exports = { buildPaymentSearchOptions };
