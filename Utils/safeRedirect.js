function getSafeReferrerPath(req, fallback = '/') {
  const fallbackPath = typeof fallback === 'string' && fallback.startsWith('/') ? fallback : '/';
  const referrer = String(req.get('Referrer') || '').trim();
  if (!referrer) return fallbackPath;

  try {
    const host = String(req.get('host') || '').trim();
    if (!host) return fallbackPath;
    const origin = `${req.protocol}://${host}`;
    const refUrl = new URL(referrer, origin);

    if (refUrl.origin !== origin) return fallbackPath;

    const resolvedPath = `${refUrl.pathname || ''}${refUrl.search || ''}${refUrl.hash || ''}`;
    return resolvedPath.startsWith('/') ? resolvedPath : fallbackPath;
  } catch (err) {
    return fallbackPath;
  }
}

module.exports = {
  getSafeReferrerPath
};
