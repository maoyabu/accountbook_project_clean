require('dotenv').config();
const mongoose = require('mongoose');
const Eventcal = require('../models/eventcal');
const Eventcal_events = require('../models/eventcal_events');
const Eventcal_settings = require('../models/eventcal_settings');
const DiaryKeywordMap = require('../models/diary_keyword_map');
const Group = require('../models/groups');
const { extractDiaryTags } = require('../Utils/diaryTags');
const { getFiscalYearForDate, getFiscalYearRange, normalizeFiscalStartMonth } = require('../Utils/fiscalYear');

const dburl = process.env.DB_URL || 'mongodb://localhost:27017/finance';

const getGroupFiscalStartMonth = async (groupId) => {
  if (!groupId) return 1;
  const group = await Group.findById(groupId).select('financeFiscalStartMonth');
  return normalizeFiscalStartMonth(group?.financeFiscalStartMonth);
};

const hashString = (str) => {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};

const buildKeywordCounts = async (entries, excludedEventKeySet, excludeWords) => {
  const excludeWordSet = new Set((excludeWords || []).map(w => String(w).trim().toLowerCase()).filter(Boolean));
  const keywordCountMap = new Map();

  for (const entry of entries) {
    const eventKey = `${entry.item || ''}||${entry.event || ''}`;
    if (excludedEventKeySet.has(eventKey)) continue;
    const tagSource = [entry.title, entry.summary, entry.content].filter(Boolean).join(' ');
    const rawTags = Array.isArray(entry.tags) && entry.tags.length > 0
      ? entry.tags
      : await extractDiaryTags(tagSource, { excludeWords });

    rawTags.forEach((tag) => {
      const name = String(tag?.name || '').trim();
      if (!name) return;
      if (excludeWordSet.has(name.toLowerCase())) return;
      const inc = Number.isFinite(Number(tag.score)) ? Number(tag.score) : 1;
      keywordCountMap.set(name, (keywordCountMap.get(name) || 0) + inc);
    });
  }

  return keywordCountMap;
};

const buildCooccurrence = (entries, topTagSet) => {
  const names = Array.from(topTagSet);
  const index = new Map(names.map((n, i) => [n, i]));
  const n = names.length;
  const counts = new Array(n).fill(0);
  const cooc = Array.from({ length: n }, () => new Array(n).fill(0));

  for (const entry of entries) {
    const tags = (entry.tags || []).map(t => t?.name).filter(Boolean);
    const filtered = Array.from(new Set(tags.filter(t => topTagSet.has(t))));
    if (filtered.length === 0) continue;
    filtered.forEach(t => {
      const i = index.get(t);
      if (i !== undefined) counts[i] += 1;
    });
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const ai = index.get(filtered[i]);
        const bi = index.get(filtered[j]);
        if (ai === undefined || bi === undefined) continue;
        cooc[ai][bi] += 1;
        cooc[bi][ai] += 1;
      }
    }
  }

  return { names, counts, cooc };
};

const layoutKeywordMap = (names, counts, cooc) => {
  const n = names.length;
  if (n === 0) return [];

  const x = new Array(n);
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = hashString(names[i]);
    const angle = (h % 360) * (Math.PI / 180);
    const radius = 20 + (h % 30);
    x[i] = Math.cos(angle) * radius;
    y[i] = Math.sin(angle) * radius;
  }

  const iterations = 220;
  const repulsion = 1200;
  const attraction = 0.02;
  const minDist = 8;

  for (let iter = 0; iter < iterations; iter++) {
    const fx = new Array(n).fill(0);
    const fy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const rep = repulsion / (dist * dist);
        const rx = (dx / dist) * rep;
        const ry = (dy / dist) * rep;
        fx[i] += rx;
        fy[i] += ry;
        fx[j] -= rx;
        fy[j] -= ry;

        const sim = (cooc[i]?.[j] || 0) / Math.sqrt(Math.max(1, counts[i]) * Math.max(1, counts[j]));
        if (sim > 0) {
          const target = minDist + (1 - Math.min(sim, 1)) * 25;
          const ax = (dx / dist) * (dist - target) * attraction;
          const ay = (dy / dist) * (dist - target) * attraction;
          fx[i] -= ax;
          fy[i] -= ay;
          fx[j] += ax;
          fy[j] += ay;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      x[i] += fx[i] * 0.01;
      y[i] += fy[i] * 0.01;
    }
  }

  let minX = Math.min(...x);
  let maxX = Math.max(...x);
  let minY = Math.min(...y);
  let maxY = Math.max(...y);
  const pad = 5;
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);

  return names.map((name, i) => ({
    name,
    x: pad + ((x[i] - minX) / rangeX) * (100 - pad * 2),
    y: pad + ((y[i] - minY) / rangeY) * (100 - pad * 2),
    count: counts[i] || 0
  }));
};

const buildAndStoreKeywordMap = async (userId, groupId, fiscalYear, fiscalStartMonth) => {
  const fiscalRange = getFiscalYearRange(fiscalYear, fiscalStartMonth);
  const settings = await Eventcal_settings.findOne({ user: userId, group: groupId }).select('excludeWords');
  const excludedEvents = await Eventcal_events.find({
    user: userId,
    group: groupId,
    excludeFromTags: true
  }).select('item event');
  const excludedEventKeySet = new Set(
    excludedEvents.map(ev => `${ev.item || ''}||${ev.event || ''}`)
  );

  const entries = await Eventcal.find({
    user: userId,
    group: groupId,
    date: { $gte: fiscalRange.start, $lt: fiscalRange.end }
  }).select('date item event title summary content tags');

  const keywordCountMap = await buildKeywordCounts(entries, excludedEventKeySet, settings?.excludeWords);
  const top50 = Array.from(keywordCountMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 50);
  const topTagSet = new Set(top50.map(t => t.name));

  const { names, counts, cooc } = buildCooccurrence(entries, topTagSet);
  const positions = layoutKeywordMap(names, counts, cooc);
  const positionMap = new Map(positions.map(p => [p.name, p]));
  const merged = top50.map(item => ({
    name: item.name,
    count: item.count,
    x: positionMap.get(item.name)?.x,
    y: positionMap.get(item.name)?.y
  }));

  await DiaryKeywordMap.findOneAndUpdate(
    { user: userId, group: groupId, year: fiscalYear },
    { positions: merged },
    { upsert: true, new: true }
  );
};

const run = async () => {
  await mongoose.connect(dburl);
  const groupIds = await Eventcal.distinct('group');
  for (const groupId of groupIds) {
    if (!groupId) continue;
    const fiscalStartMonth = await getGroupFiscalStartMonth(groupId);
    const fiscalYear = getFiscalYearForDate(new Date(), fiscalStartMonth) ?? new Date().getFullYear();
    const userIds = await Eventcal.distinct('user', { group: groupId });
    for (const userId of userIds) {
      if (!userId) continue;
      await buildAndStoreKeywordMap(userId, groupId, fiscalYear, fiscalStartMonth);
      console.log(`keyword map updated: group=${groupId} user=${userId} year=${fiscalYear}`);
    }
  }
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
