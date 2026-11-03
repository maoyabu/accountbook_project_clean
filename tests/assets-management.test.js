const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '..');
const assetId = '507f1f77bcf86cd799439011';
const inventoryId = '507f1f77bcf86cd799439012';

function query(value) {
  const promise = Promise.resolve(value);
  promise.sort = promise.populate = promise.select = () => promise;
  return promise;
}
function setup() {
  const routes = [];
  const state = { assets: [], inventories: [], saved: [], queries: [] };
  class Asset {
    constructor(data) { Object.assign(this, data); }
    async save() { state.saved.push(this); }
    static find(filter) { state.queries.push(['assets', filter]); return query(state.assets); }
    static findOne(filter) { state.queries.push(['asset', filter]); return query(state.assets[0] || null); }
    static async findOneAndUpdate(filter, update) { state.queries.push(['update', filter, update]); return state.assets[0] || null; }
    static async deleteOne(filter) { state.queries.push(['delete', filter]); return { deletedCount: 1 }; }
  }
  const Inventory = {
    find: filter => { state.queries.push(['inventories', filter]); return query(state.inventories); },
    findOne: filter => { state.queries.push(['inventory', filter]); return query(state.inventories[0] || null); },
    create: async data => { const inventory = { ...data, _id: inventoryId }; state.saved.push(inventory); return inventory; }
  };
  const router = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (...args) => routes.push({ method, args })]));
  const scopedRequire = name => {
    if (name === 'express') return { Router: () => router };
    if (name === 'mongoose') return mongoose;
    if (name === '../models/assets') return Asset;
    if (name === '../models/assetInventory') return Inventory;
    if (name === '../middleware') return { ensureAuthenticated: () => {}, logAction: async () => {} };
    if (['../models/users', 'passport', 'axios'].includes(name)) return {};
    if (name === 'crypto') return require('node:crypto');
    throw Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'routes/asset.js'), 'utf8'), { require: scopedRequire, module: { exports: {} }, console });
  const route = (method, url) => routes.find(entry => entry.method === method && entry.args[0] === url).args;
  return { state, route };
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    redirect(url) { this.redirectTo = url; }, render(view, locals) { this.view = view; this.locals = locals; } };
}
function request(body = {}) {
  return { body, params: { id: assetId }, query: {}, session: { activeGroupId: 'group-a' }, user: { _id: 'user-a' }, flash() {}, get: () => 'application/json' };
}
const assetData = { _id: assetId, asset_cf: '金融資産', asset_item: '預貯金', content: '普通預金', amount: 200000, monetary_unit: '円', entry_date: new Date('2026-01-01'), update_date: new Date('2026-11-01') };
const currentAsset = extra => { const data = { ...assetData, ...extra }; return { ...data, toObject: () => ({ ...data }) }; };

test('overview uses current assets rather than an old inventory snapshot', async () => {
  const { state, route } = setup();
  state.assets = [currentAsset(), currentAsset({ _id: inventoryId, asset_cf: '負債', asset_item: '住宅ローン', amount: -50000 })];
  state.inventories = [{ _id: inventoryId, inventoryMonth: new Date('2026-09-01'), totalYen: 999999, totalByCf: { 金融資産: 999999 }, items: [] }];
  const res = response(); await route('get', '/display').at(-1)(request(), res);
  assert.equal(res.view, 'assets/display'); assert.equal(res.locals.totalYen, 150000);
  assert.equal(res.locals.assets[0].amountYen, 200000); assert.equal(res.locals.assets[1].amountYen, -50000);
  assert.equal(res.locals.chartData.series.financial[0], 999999);
  assert.equal(state.queries[0][1].group, 'group-a');
});

test('invalid asset data and missing group are rejected before mutation', () => {
  const { state, route } = setup(); const validate = route('post', '/create')[2];
  for (const body of [{ ...assetData, amount: '' }, { ...assetData, amount: 'Infinity' }, { ...assetData, asset_item: 'Please Choice' }, { ...assetData, monetary_unit: 'Please Choice' }]) {
    const res = response(); let passed = false; validate(request(body), res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.statusCode, 400);
  }
  const req = request(assetData); req.session = {}; const res = response();
  validate(req, res, () => assert.fail('No group should be rejected')); assert.equal(res.statusCode, 403);
  assert.equal(state.saved.length, 0);
});

test('create, update and delete are scoped to the active group; untouched notes are omitted', async () => {
  const { state, route } = setup(); state.assets = [currentAsset()];
  const req = request(assetData); const created = response(); await route('post', '/create').at(-1)(req, created);
  assert.equal(created.body.ok, true); assert.equal(state.saved[0].group, 'group-a'); assert.equal(state.saved[0].createdBy, 'user-a');
  const updated = response(); await route('post', '/update/:id').at(-1)(req, updated);
  assert.equal(updated.body.ok, true);
  const mutation = state.queries.find(item => item[0] === 'update');
  assert.equal(mutation[1].group, 'group-a'); assert.equal(mutation[1]._id, assetId);
  assert.equal(Object.hasOwn(mutation[2], 'secure_note'), false);
  const deleted = response(); await route('delete', '/:id').at(-1)(req, deleted);
  assert.equal(state.queries.find(item => item[0] === 'delete')[1].group, 'group-a');
  assert.equal(deleted.redirectTo, '/asset/display#assetList');
});

test('snapshot detail preserves deleted assets and queries only the active group', async () => {
  const { state, route } = setup();
  state.inventories = [{ inventoryMonth: new Date('2026-09-01'), items: [{ content: '削除済みの資産', amountYen: 1234 }] }];
  const res = response(); await route('get', '/history/:id').at(-1)(request(), res);
  assert.equal(res.view, 'assets/historyDetail'); assert.equal(res.locals.inventory.items[0].content, '削除済みの資産');
  assert.equal(state.queries[0][1].group, 'group-a');
  state.inventories = []; const absent = response(); await route('get', '/history/:id').at(-1)(request(), absent); assert.equal(absent.statusCode, 404);
});

test('unified overview renders modals, dates, tags and escaped row data', () => {
  const render = assets => ejs.render(fs.readFileSync(path.join(root, 'views/assets/display.ejs'), 'utf8'), {
    layout() {}, assets, inventoryCallout: null, latestInventory: null, totalYen: 200000,
    totalByCf: { 金融資産: 200000, 実物資産: 0, 無形資産: 0, 負債: 0 }, chartData: { labels: [], series: {} }, showRateInfo: false,
    asset_cfs: ['Please Choice', '金融資産'], current_assets: ['預貯金'], fixed_assets: [], intangible_assets: [], monetary_units: ['円']
  }, { filename: path.join(root, 'views/assets/display.ejs') });
  const content = `普通預金 "'><script>alert(1)</script>`;
  const $ = cheerio.load(render([{ ...assetData, content, amountYen: 200000, secure_note: 'NEVER_RENDER_THIS_NOTE' }]));
  assert.equal($('#newAssetBtn').length, 1); assert.equal($('#assetModal').length, 1); assert.equal($('#assetForm').length, 1);
  assert.equal($('.asset-management-row button').length, 0); assert.equal($('#assetRowMenu [role="menuitem"]').length, 2);
  assert.equal($('.asset-management-row .notice-chip').length, 2);
  assert.equal(JSON.parse($('.asset-management-row').attr('data-asset')).content, content);
  assert.equal($('.asset-management-row script').length, 0); assert(!$.html().includes('NEVER_RENDER_THIS_NOTE'));
  assert($('.notice-asset-dates').text().includes('登録')); assert($('.notice-asset-dates').text().includes('更新'));
  assert.equal($('a[href="/asset/inventory"]').length, 1); assert.equal($('a[href="/asset/history"]').length, 1);
  const empty = cheerio.load(render([])); assert.equal(empty('#newAssetBtn').length, 1); assert.equal(empty('.notice-empty').length, 1);
});


test('inventory save opens the saved snapshot detail and leaves current assets unchanged', async () => {
  const { state, route } = setup(); state.assets = [currentAsset()];
  const req = request({ inventoryMonth: '2020-09', items: [{ asset: assetId, amount: '250000', amountYen: '250000' }] });
  const res = response(); await route('post', '/inventory').at(-1)(req, res);
  assert.equal(res.redirectTo, `/asset/history/${inventoryId}`);
  assert.equal(state.saved[0].totalYen, 250000); assert.equal(state.saved[0].group, 'group-a');
  assert.equal(state.assets[0].amount, 200000);
});

function clientFixture() {
  const ids = {};
  const element = () => {
    const classes = new Set();
    return { events: {}, style: {}, dataset: {}, value: '', disabled: false, options: [{ value: 'Please Choice' }],
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      addEventListener(name, fn) { (this.events[name] ||= []).push(fn); },
      emit(name, event = {}) { return Promise.all((this.events[name] || []).map(fn => fn(event))); },
      setAttribute(name, value) { if (name === 'disabled') this.disabled = true; },
      removeAttribute(name) { if (name === 'disabled') this.disabled = false; },
      querySelectorAll() { return []; }, querySelector() { return submitButton; },
      focus() {}, contains() { return false; }, getBoundingClientRect() { return { left: 10, top: 20 }; }
    };
  };
  const submitButton = element();
  for (const id of ['asset_cf', 'current_asset_group', 'fixed_asset_group', 'intangible_asset_group', 'debt_group', 'assetModal', 'assetModalLabel', 'assetForm', 'newAssetBtn', 'unlockSecureNoteBtn', 'secureNoteAuthSection', 'verifySecureNoteBtn', 'secureNotePassword', 'secure_note', 'assetIdField', 'assetFormError', 'assetRowMenu', 'assetRowEdit', 'assetRowDelete', 'code', 'content', 'amount', 'monetary_unit', 'asset_item_current', 'asset_item_fixed', 'asset_item_intangible', 'asset_item_debt']) ids[id] = element();
  const groupInputs = ['asset_item_current', 'asset_item_fixed', 'asset_item_intangible', 'asset_item_debt'];
  ['current_asset_group', 'fixed_asset_group', 'intangible_asset_group', 'debt_group'].forEach((name, i) => { ids[name].querySelectorAll = () => [ids[groupInputs[i]]]; });
  ids.assetForm.reset = () => { for (const id of ['asset_cf', 'code', 'content', 'amount', 'monetary_unit', ...groupInputs]) ids[id].value = ''; };
  const row = element(); row.dataset = { id: assetId, asset: JSON.stringify({ ...assetData, id: assetId }) };
  const doc = element(); doc.getElementById = id => ids[id] || null;
  doc.querySelectorAll = selector => selector === '.asset-management-row' ? [row] : [];
  const win = element(); win.location = { search: '', href: '' }; win.innerWidth = 400; win.innerHeight = 600; win.confirm = () => false;
  let shown = 0, timer, requests = [], failure = false;
  const context = { document: doc, window: win, console, URLSearchParams,
    alert: message => { throw Error(message); },
    bootstrap: { Modal: function () { return { show() { shown++; } }; } },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
    FormData: class { *[Symbol.iterator]() { yield ['content', ids.content.value]; } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: !failure, json: async () => failure ? { ok: false, message: '保存失敗' } : url.startsWith('/secure-note/') ? { secure_note: '認証後の機密情報' } : { ok: true } }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/assetManagement.js'), 'utf8'), context);
  return { ids, row, doc, win, context, requests, shown: () => shown, timer: () => timer, fail: () => { failure = true; } };
}

test('right-click edits raw values; touch hold cancels while scrolling; delete asks for confirmation', async () => {
  const ui = clientFixture(); await ui.doc.emit('DOMContentLoaded');
  let prevented = false;
  await ui.row.emit('contextmenu', { preventDefault() { prevented = true; }, clientX: 380, clientY: 590 });
  assert(prevented); assert(ui.ids.assetRowMenu.classList.contains('show'));
  assert.equal(ui.ids.assetRowDelete.action, `/asset/${assetId}?_method=DELETE`);
  await ui.ids.assetRowEdit.emit('click'); assert.equal(ui.ids.content.value, '普通預金'); assert.equal(ui.ids.amount.value, 200000);
  assert.equal(ui.shown(), 1); assert.equal(ui.ids.secure_note.disabled, true);
  await ui.row.emit('pointerdown', { pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 });
  await ui.row.emit('pointermove', { clientX: 25, clientY: 10 }); assert.equal(ui.timer(), null);
  await ui.row.emit('pointerdown', { pointerType: 'mouse', isPrimary: true, button: 0 }); assert.equal(ui.timer(), null);
  await ui.row.emit('pointerdown', { pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 }); ui.timer()();
  assert(ui.ids.assetRowMenu.classList.contains('show'));
  let cancelled = false; await ui.ids.assetRowDelete.emit('submit', { preventDefault() { cancelled = true; } }); assert(cancelled);
});

test('modal authentication clears sensitive fields on close and retains edits after a save error', async () => {
  const ui = clientFixture(); await ui.doc.emit('DOMContentLoaded');
  await ui.row.emit('contextmenu', { preventDefault() {}, clientX: 10, clientY: 10 }); await ui.ids.assetRowEdit.emit('click');
  ui.ids.secureNotePassword.value = 'test-only-password'; await ui.ids.verifySecureNoteBtn.emit('click');
  assert.equal(ui.ids.secure_note.value, '認証後の機密情報'); assert.equal(ui.ids.secure_note.disabled, false);
  ui.ids.content.value = '変更した内容'; ui.fail(); await ui.ids.assetForm.emit('submit', { preventDefault() {} });
  assert.equal(ui.ids.assetFormError.textContent, '保存失敗'); assert.equal(ui.ids.content.value, '変更した内容'); assert.equal(ui.win.location.href, '');
  await ui.ids.assetModal.emit('hidden.bs.modal'); assert.equal(ui.ids.secure_note.value, ''); assert.equal(ui.ids.secure_note.disabled, true); assert.equal(ui.ids.secureNotePassword.value, '');
});
