const FinanceUser = require('../models/users');
const express = require('express');
const router = express.Router();
const Asset = require('../models/assets');
const AssetInventory = require('../models/assetInventory');
const { ensureAuthenticated } = require('../middleware');
const { isLoggedIn, logAction } = require('../middleware');
const passport = require('passport');
const crypto = require('crypto');
const mongoose = require('mongoose');

//selectedの選択肢をここで定義
const asset_cfs = ['Please Choice','金融資産','実物資産','無形資産','負債'];
const current_assets = ['Please Choice','預貯金','定期預金','為替','小切手','株式','投資信託','債権','生命保険','その他流動資産'];
const fixed_assets = ['Please Choice','土地・建物','株式','債権','生命保険','定期預金','その他固定資産'];
const intangible_assets = ['Please Choice','著作権','商標権','特許','その他無形資産'];
const debt = ['Please Choice','住宅ローン','自動車ローン','その他ローン','その他負債'];
const monetary_units = ['Please Choice','円','$','数量',];

const QUARTER_MONTHS = [2, 5, 8, 11]; // 3, 6, 9, 12

// 棚卸しを行える直近（かつ過ぎていない）四半期の開始月を返す。3/6/9/12基準。
const getQuarterStart = (date) => {
  const month = date.getMonth();
  const passed = QUARTER_MONTHS.filter((m) => m <= month);
  if (passed.length) {
    return new Date(date.getFullYear(), passed[passed.length - 1], 1);
  }
  // まだ3月に到達していない場合は前年12月を返す
  return new Date(date.getFullYear() - 1, QUARTER_MONTHS[QUARTER_MONTHS.length - 1], 1);
};

const formatYearMonth = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

//資産登録画面・編集画面　表示
// 資産登録画面の表示

// 資産一覧表示
router.get('/', ensureAuthenticated, async (req, res) => {
    try {
      const groupId = req.session.activeGroupId;
      const currentQuarterMonth = getQuarterStart(new Date());
      const latestInventory = await AssetInventory.findOne({ group: groupId }).sort({ inventoryMonth: -1 });

      // 棚卸し時期なら棚卸し画面へ誘導する
      if (!req.query.skipInventory) {
        const needsInventory = !latestInventory || latestInventory.inventoryMonth < currentQuarterMonth;
        if (needsInventory) {
          return res.redirect(`/asset/inventory?month=${formatYearMonth(currentQuarterMonth)}`);
        }
      }

      const assets = await Asset.find({ group: groupId })
        .sort({ entry_date: -1 })
        .populate('createdBy', 'username displayname')
        .populate('updatedBy', 'username displayname');
      res.render('assets/edit', {
        assets,
        editAsset: null,
        asset_cfs,
        current_assets,
        fixed_assets,
        intangible_assets,
        monetary_units,
        latestInventory
      });
    } catch (err) {
      console.error(err);
      res.status(500).send('エラーが発生しました。');
    }
});

// 資産登録
router.post('/create', ensureAuthenticated, async (req, res) => {
    const activeGroupId = req.session.activeGroupId;
    if (!activeGroupId) {
        req.flash('error', 'アクティブなグループが選択されていません');
        return res.redirect('/group_list');
    }

    try {
      const { asset_cf, asset_item, code, content, amount, monetary_unit } = req.body;

      const newAsset = new Asset({
        asset_cf,
        asset_item,
        code,
        content,
        amount,
        monetary_unit,
        user: req.user._id,
        createdBy: req.user._id,
        updatedBy: req.user._id,
        group: activeGroupId,
        entry_date: new Date(),
        update_date: new Date(),
        secure_note: req.body.secure_note // will be encrypted via schema pre-save
      });
  
      await newAsset.save();
      await logAction({ req, action: '登録', target: '資産管理' });
      res.redirect('/asset');
    } catch (err) {
      console.error(err);
      res.status(500).send('登録中にエラーが発生しました。');
    }
});  

// 資産削除
router.delete('/:id', ensureAuthenticated, async (req, res) => {
    try {
      await Asset.deleteOne({ _id: req.params.id, group: req.session.activeGroupId });
      await logAction({ req, action: '削除', target: '資産管理' });
      res.redirect('/asset');
    } catch (err) {
      console.error(err);
      res.status(500).send('削除中にエラーが発生しました。');
    }
});

//資産の編集画面の表示
router.get('/edit/:id', ensureAuthenticated, async (req, res) => {
  try {
    const asset = await Asset.findOne({ _id: req.params.id, group: req.session.activeGroupId });
    if (!asset) {
      req.flash('error', '資産が見つかりません');
      return res.redirect('/asset');
    }
    return res.redirect(`/asset?assetId=${asset._id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('編集画面の表示中にエラーが発生しました。');
  }
});

//資産の更新処理
router.post('/update/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { asset_cf, asset_item, code, content, amount, monetary_unit, secure_note } = req.body;

    const result = await Asset.findOneAndUpdate(
      { _id: req.params.id, group: req.session.activeGroupId },
      {
        asset_cf,
        asset_item,
        code,
        content,
        amount,
        monetary_unit,
        secure_note, // 平文のまま渡し、モデル側で暗号化
        update_date: new Date(),
        updatedBy: req.user._id
      }
    );

    if (!result) {
      console.error('更新対象の資産が見つかりませんでした。');
      return res.status(404).send('資産が見つかりません');
    }

    await logAction({ req, action: '更新', target: '資産管理' });
    res.redirect('/asset');
  } catch (err) {
    console.error('更新エラー内容:', err);
    res.status(500).send('更新中にエラーが発生しました。');
  }
});

// USDなどの通貨コードを受け取って円レートを取得
//資産状況画面表示
//axiosを使ってUSD　→　円の換算
const axios = require('axios');
let cheerioInstance;
const getCheerio = () => {
  if (!cheerioInstance) {
    cheerioInstance = require('cheerio');
  }
  return cheerioInstance;
};

// 日経からスクレイピングして前日の終値を取得する
async function getExchangeRate(code) {
    if (code === '$') {
      const url = 'https://www.nikkei.com/markets/worldidx/chart/usdjpy/';
      try {
        const response = await axios.get(url);
        const html = response.data;
        const $ = getCheerio().load(html);
        const rateText = $('span.m-trend_economic_table_value.a-tar').first().text().replace(/,/g, '');
        const rate = parseFloat(rateText);
        if (!isNaN(rate)) {
        //   console.log('為替レート取得成功（Nikkei）:', rate);
          return rate;
        } else {
          throw new Error('為替レートの数値変換に失敗');
        }
      } catch (err) {
        console.error('為替レート取得エラー（Nikkei）:', err.message);
        return 150; // fallback
      }
    }
    return 1;
  }

async function getStockPriceFromNIkkei(stockCode) {
  const url = `https://www.nikkei.com/nkd/company/history/dprice/?scode=${stockCode}&ba=1`;
  try {
    const response = await axios.get(url);
    const html = response.data;
    const $ = getCheerio().load(html);
    const priceText = $('dd.m-stockPriceElm_value.now').first().text().replace(/[,円\s]/g, '');
    const price = parseFloat(priceText);
    if (!isNaN(price)) {
      //console.log(`日経から株価取得成功 (${stockCode}):`, price);
      return price;
    } else {
      throw new Error('株価が数値に変換できません');
    }
  } catch (err) {
    console.error(`株価取得エラー（日経, ${stockCode}）:`, err.message);
    return 1;
  }
}
// 円換算の計算を共通化
async function calculateAssetYen(asset, rateCache = {}, stockCache = {}) {
  if (asset.asset_item === '為替') {
    const code = asset.code || '$';
    if (!rateCache[code]) {
      rateCache[code] = await getExchangeRate(code);
    }
    return Math.round(asset.amount * rateCache[code]);
  }

  if (asset.asset_item === '株式' && asset.monetary_unit === '数量') {
    const code = asset.code;
    if (code) {
      if (!stockCache[code]) {
        stockCache[code] = await getStockPriceFromNIkkei(code);
      }
      return Math.round(asset.amount * stockCache[code]);
    }
  }

  return Math.round(asset.amount);
}

// 棚卸し日を基準に株価を取得（なければ最新）
async function getStockPriceAtDate(stockCode, targetDate) {
  if (!stockCode) return 1;
  const year = targetDate.getFullYear();
  const url = `https://kabuoji3.com/stock/${stockCode}/${year}/`;
  try {
    const response = await axios.get(url);
    const $ = getCheerio().load(response.data);
    let chosen = null;
    const targetTime = targetDate.getTime();

    $('table.stock_table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 5) return;
      const dateStr = $(tds[0]).text().trim();
      const priceStr = $(tds[4]).text().replace(/,/g, '').trim() || $(tds[1]).text().replace(/,/g, '').trim();
      const parsed = new Date(dateStr);
      const price = parseFloat(priceStr);
      if (isNaN(parsed) || isNaN(price)) return;
      const time = parsed.getTime();
      if (time <= targetTime && chosen === null) {
        chosen = price;
      }
    });

    if (chosen !== null && !isNaN(chosen)) {
      return chosen;
    }
  } catch (err) {
    console.error(`株価履歴取得エラー（${stockCode}）:`, err.message);
  }
  // fallback to latest
  return getStockPriceFromNIkkei(stockCode);
}

async function calculateStockYenOnDate(asset, quantity, targetDate, stockCache = {}) {
  const code = asset.code;
  if (!code) return Math.round(quantity || 0);
  const cacheKey = `${code}-${formatYearMonth(targetDate)}`;
  if (!stockCache[cacheKey]) {
    stockCache[cacheKey] = await getStockPriceAtDate(code, targetDate);
  }
  return Math.round(quantity * stockCache[cacheKey]);
}

// 棚卸し履歴をグラフ用の配列に整形
function buildInventoryChartData(inventories = []) {
  const labels = [];
  const series = {
    financial: [],
    physical: [],
    intangible: [],
    debt: [],
    total: []
  };

  inventories.forEach((inv) => {
    const totals =
      inv.totalByCf instanceof Map ? Object.fromEntries(inv.totalByCf) : inv.totalByCf || {};
    const financial = totals['金融資産'] || 0;
    const physical = totals['実物資産'] || 0;
    const intangible = totals['無形資産'] || 0;
    const debt = totals['負債'] || 0;
    const total = financial + physical + intangible + debt;

    labels.push(
      `${inv.inventoryMonth.getFullYear()}年${String(inv.inventoryMonth.getMonth() + 1).padStart(2, '0')}月`
    );
    series.financial.push(financial);
    series.physical.push(physical);
    series.intangible.push(intangible);
    series.debt.push(debt);
    series.total.push(total);
  });

  return { labels, series };
}

// 棚卸し告知（棚卸し翌月の1ヶ月間表示）
function getInventoryCallout(now = new Date()) {
  const year = now.getFullYear();
  const candidates = [
    new Date(year - 1, 11, 1), // 前年12月
    new Date(year, 2, 1), // 3月
    new Date(year, 5, 1), // 6月
    new Date(year, 8, 1), // 9月
    new Date(year, 11, 1) // 12月
  ];

  for (const invMonth of candidates) {
    const displayMonth = new Date(invMonth.getFullYear(), invMonth.getMonth() + 1, 1);
    if (
      displayMonth.getFullYear() === now.getFullYear() &&
      displayMonth.getMonth() === now.getMonth()
    ) {
      return {
        monthValue: formatYearMonth(invMonth),
        label: `${invMonth.getFullYear()}年${String(invMonth.getMonth() + 1).padStart(2, '0')}月`,
        displayMonth
      };
    }
  }
  return null;
}

// 棚卸し画面の表示
router.get('/inventory', ensureAuthenticated, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }
    const monthParam = req.query.month;
    const now = new Date();
    const parsedMonth = monthParam ? new Date(`${monthParam}-01`) : null;
    const latestAllowedMonth = getQuarterStart(now);
    const targetMonth = parsedMonth && !isNaN(parsedMonth) ? getQuarterStart(parsedMonth) : latestAllowedMonth;

    if (targetMonth.getTime() > latestAllowedMonth.getTime()) {
      req.flash('error', '棚卸しは3・6・9・12月に到達してから登録できます。対象月を切り替えました。');
      return res.redirect(`/asset/inventory?month=${formatYearMonth(latestAllowedMonth)}`);
    }

    const assets = await Asset.find({ group: groupId }).sort({ asset_cf: 1, asset_item: 1, entry_date: -1 });
    const latestInventory = await AssetInventory.findOne({ group: groupId }).sort({ inventoryMonth: -1 }).populate('updatedBy', 'username displayname').populate('items.updatedBy', 'username displayname');
    const targetInventory = await AssetInventory.findOne({ group: groupId, inventoryMonth: targetMonth }).populate('updatedBy', 'username displayname').populate('items.updatedBy', 'username displayname');
    const prefillInventory = targetInventory || latestInventory;
    const rateCache = {};
    const stockCache = {};
    const stockDateCache = {};
    const inventoryRows = [];

    for (const asset of assets) {
      const fromInventory = prefillInventory?.items?.find((item) => item.asset?.toString() === asset._id.toString());
      const isStockQuantity = asset.asset_item === '株式' && asset.monetary_unit === '数量';
      const isFxQuantity = asset.asset_item === '為替';
      const amountFallback = isStockQuantity
        ? (typeof fromInventory?.amount === 'number' && !isNaN(fromInventory.amount) ? fromInventory.amount : asset.amount ?? 0)
        : isFxQuantity
        ? (typeof fromInventory?.amount === 'number' && !isNaN(fromInventory.amount) ? fromInventory.amount : asset.amount ?? 0)
        : (typeof fromInventory?.amountYen === 'number' && !isNaN(fromInventory.amountYen) ? fromInventory.amountYen : asset.amount ?? 0);
      let amountYen = 0;

      if (fromInventory) {
        amountYen = fromInventory.amountYen;
      } else {
        if (isStockQuantity) {
          amountYen = await calculateStockYenOnDate(asset, amountFallback, targetMonth, stockDateCache);
        } else if (isFxQuantity) {
          // 為替は数量（外貨）から換算
          const rateCode = asset.code || '$';
          if (!rateCache[rateCode]) {
            rateCache[rateCode] = await getExchangeRate(rateCode);
          }
          amountYen = Math.round(amountFallback * rateCache[rateCode]);
        } else {
          amountYen = await calculateAssetYen(asset, rateCache, stockCache);
        }
      }

      inventoryRows.push({
        asset,
        amountYen,
        amount: amountFallback,
        isStockQuantity,
        isFxQuantity,
        itemUpdatedBy: fromInventory?.updatedBy,
        itemUpdatedAt: fromInventory?.updatedAt
      });
    }

    const inventoryTitle = `${targetMonth.getFullYear()}年${String(targetMonth.getMonth() + 1).padStart(2, '0')}月の棚卸し`;

    const currentUserDisplay = req.user?.displayname || req.user?.username || '';

    res.render('assets/inventory', {
      inventoryRows,
      asset_cfs,
      targetMonthValue: formatYearMonth(targetMonth),
      targetInventory,
      latestInventory,
      inventoryTitle,
      latestAllowedMonth,
      currentUserDisplay
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('棚卸し画面の表示中にエラーが発生しました。');
  }
});

// 棚卸しの保存
router.post('/inventory', ensureAuthenticated, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }
    const { inventoryMonth, items } = req.body;
    if (!inventoryMonth) {
      req.flash('error', '棚卸し対象の年月を指定してください。');
      return res.redirect('/asset/inventory');
    }

    const monthDate = new Date(`${inventoryMonth}-01`);
    const targetMonth = getQuarterStart(monthDate);
    const latestAllowedMonth = getQuarterStart(new Date());

    if (isNaN(monthDate) || targetMonth.getTime() > latestAllowedMonth.getTime()) {
      req.flash('error', '棚卸しは3・6・9・12月に到達後に登録してください。');
      return res.redirect(`/asset/inventory?month=${formatYearMonth(latestAllowedMonth)}`);
    }
    const rawItems = Array.isArray(items) ? items : Object.values(items || {});
    const assetIds = rawItems.map((i) => i.asset).filter(Boolean);
    const assetDocs = await Asset.find({ group: groupId, _id: { $in: assetIds } });
    const assetMap = new Map(assetDocs.map((doc) => [doc._id.toString(), doc]));

    const snapshotItems = [];
    const totalByCf = { '金融資産': 0, '実物資産': 0, '無形資産': 0, '負債': 0 };
    let totalYen = 0;
    const stockDateCache = {};
    const rateCache = {};

    rawItems.forEach((input) => {
      const asset = assetMap.get(String(input.asset));
      if (!asset) return;
      const isStockQuantity = asset.asset_item === '株式' && asset.monetary_unit === '数量';
      const isFxQuantity = asset.asset_item === '為替';
      const quantity = Number(input.amount);
      const amountYenInput = Number(input.amountYen);
      const amountValue = isStockQuantity || isFxQuantity ? (isNaN(quantity) ? 0 : quantity) : (isNaN(amountYenInput) ? 0 : amountYenInput);

      snapshotItems.push({
        asset: asset._id,
        asset_cf: asset.asset_cf,
        asset_item: asset.asset_item,
        code: asset.code,
        content: asset.content,
        amount: amountValue,
        amountYen: 0, // 後でセット
        updatedBy: req.user._id,
        updatedAt: new Date()
      });
    });

    // 株式（数量入力）は換算を計算しつつ合計へ集計
    for (const item of snapshotItems) {
      const asset = assetMap.get(String(item.asset));
      if (!asset) continue;
      const isStockQuantity = asset.asset_item === '株式' && asset.monetary_unit === '数量';
      const isFxQuantity = asset.asset_item === '為替';
      if (isStockQuantity) {
        const yenValue = await calculateStockYenOnDate(asset, item.amount, targetMonth, stockDateCache);
        item.amountYen = yenValue;
      } else if (isFxQuantity) {
        const code = asset.code || '$';
        if (!rateCache[code]) {
          rateCache[code] = await getExchangeRate(code);
        }
        item.amountYen = Math.round(item.amount * rateCache[code]);
      } else {
        item.amountYen = item.amount;
      }

      totalYen += item.amountYen;
      if (totalByCf[asset.asset_cf] !== undefined) {
        totalByCf[asset.asset_cf] += item.amountYen;
      }
    }

    const existing = await AssetInventory.findOne({ group: groupId, inventoryMonth: targetMonth });

    if (existing) {
      existing.items = snapshotItems;
      existing.totalYen = totalYen;
      existing.totalByCf = totalByCf;
      existing.updatedBy = req.user._id;
      await existing.save();
    } else {
      await AssetInventory.create({
        group: groupId,
        inventoryMonth: targetMonth,
        items: snapshotItems,
        totalYen,
        totalByCf,
        createdBy: req.user._id,
        updatedBy: req.user._id
      });
    }

    await logAction({ req, action: '棚卸し保存', target: '資産管理' });
    req.flash('success', '棚卸しを保存しました。');
    res.redirect('/asset/history');
  } catch (err) {
    console.error(err);
    res.status(500).send('棚卸しの保存中にエラーが発生しました。');
  }
});

// 資産棚卸し履歴
router.get('/history', ensureAuthenticated, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }
    const inventories = await AssetInventory.find({ group: groupId })
      .sort({ inventoryMonth: -1 })
      .populate('updatedBy', 'username displayname')
      .populate('items.updatedBy', 'username displayname');

    const history = inventories.map((inv) => {
      const totalByCf = inv.totalByCf instanceof Map ? Object.fromEntries(inv.totalByCf) : inv.totalByCf || {};
      const sortedItems = [...inv.items].sort((a, b) => {
        if (a.asset_cf === b.asset_cf) {
          return (a.asset_item || '').localeCompare(b.asset_item || '');
        }
        return (a.asset_cf || '').localeCompare(b.asset_cf || '');
      });
      return {
        id: inv._id,
        label: `${inv.inventoryMonth.getFullYear()}年${String(inv.inventoryMonth.getMonth() + 1).padStart(2, '0')}月`,
        totalYen: inv.totalYen,
        totalByCf,
        updatedAt: inv.updatedAt,
        updatedBy: inv.updatedBy,
        items: sortedItems
      };
    });

    res.render('assets/history', { history });
  } catch (err) {
    console.error(err);
    res.status(500).send('履歴の取得中にエラーが発生しました。');
  }
});

// 資産履歴グラフ
router.get('/history/graph', ensureAuthenticated, async (req, res) => {
  try {
    const groupId = req.session.activeGroupId;
    if (!groupId) {
      req.flash('error', 'アクティブなグループが選択されていません');
      return res.redirect('/group_list');
    }
    const inventories = await AssetInventory.find({ group: groupId }).sort({ inventoryMonth: 1 });

    const chartData = buildInventoryChartData(inventories);

    res.render('assets/historyGraph', {
      chartData: JSON.stringify(chartData)
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('グラフ表示中にエラーが発生しました。');
  }
});
//myTopに資産概要の表示
router.get('/display', ensureAuthenticated, async (req, res) => {
    try {
        const groupId = req.session.activeGroupId;
        if (!groupId) {
          req.flash('error', 'アクティブなグループが選択されていません');
          return res.redirect('/group_list');
        }
        const assets = await Asset.find({ group: groupId }).sort({ entry_date: -1 });
        const inventories = await AssetInventory.find({ group: groupId }).sort({ inventoryMonth: 1 });
        let exchangeRate = 1;
        let stockPrices = {};
    
        let totalYen = 0;
        let totalByCf = { '金融資産': 0, '実物資産': 0, '無形資産': 0, '負債': 0 };
        const assetDisplayList = [];
    
        for (const asset of assets) {
            let yenValue;
    
          if (asset.asset_item === '為替') {
            exchangeRate = await getExchangeRate(asset.code);
            yenValue = Math.round(asset.amount * exchangeRate);
          } else if (asset.asset_item === '株式' && asset.monetary_unit === '数量') {
            const code = asset.code;
            if (!stockPrices[code]) {
              stockPrices[code] = await getStockPriceFromNIkkei(code);
            }
            yenValue = Math.round(asset.amount * stockPrices[code]);
          } else {
            yenValue = Math.round(asset.amount);
          }
    
          totalYen += yenValue;
          if (totalByCf[asset.asset_cf] !== undefined) {
            totalByCf[asset.asset_cf] += yenValue;
          }
    
          assetDisplayList.push({
            asset_cf: asset.asset_cf,
            asset_item: asset.asset_item,
            code: asset.code,
            content: asset.content,
            amount: yenValue
          });
    }

        res.render('assets/display', {
            assets: assetDisplayList,
            totalYen,
            totalByCf,
            exchangeRate,
            stockPrices,
            chartData: buildInventoryChartData(inventories),
            latestInventory: inventories[inventories.length - 1] || null,
            inventoryCallout: getInventoryCallout(new Date())
          });
  
        } catch (err) {
          console.error(err);
          res.status(500).send('エラーが発生しました。');
    }
});

module.exports = router;
