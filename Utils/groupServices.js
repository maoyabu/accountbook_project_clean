// Missing group-level settings retain the existing default (enabled).
function isGroupServiceEnabled(user, groupId, serviceKey) {
  if (!user) return false;
  const gid = groupId ? groupId.toString() : null;
  if (gid && user.servicesByGroup) {
    const map = user.servicesByGroup;
    const groupServices = typeof map.get === 'function' ? map.get(gid) : map[gid];
    if (groupServices && typeof groupServices[serviceKey] === 'boolean') return groupServices[serviceKey];
  }
  return true;
}
module.exports = { isGroupServiceEnabled };
