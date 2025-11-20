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
const iv = crypto.randomBytes(16);

const getQuarterStart = (date) => {
  const month = date.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(date.getFullYear(), quarterStartMonth, 1);
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

      const assets = await Asset.find({ group: groupId }).sort({ entry_date: -1 });
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
        group: activeGroupId,
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

    const assets = await Asset.find({ group: req.session.activeGroupId }).sort({ entry_date: -1 });

    res.render('assets/edit', {
      assets,
      editAsset: asset,
      asset_cfs,
      current_assets,
      fixed_assets,
      intangible_assets,
      monetary_units
    });
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
        update_date: new Date()
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
    const targetBase = parsedMonth && !isNaN(parsedMonth) ? parsedMonth : getQuarterStart(now);
    const targetMonth = new Date(targetBase.getFullYear(), targetBase.getMonth(), 1);

    const assets = await Asset.find({ group: groupId }).sort({ asset_cf: 1, asset_item: 1, entry_date: -1 });
    const latestInventory = await AssetInventory.findOne({ group: groupId }).sort({ inventoryMonth: -1 }).populate('updatedBy', 'username displayname');
    const targetInventory = await AssetInventory.findOne({ group: groupId, inventoryMonth: targetMonth }).populate('updatedBy', 'username displayname');
    const prefillInventory = targetInventory || latestInventory;
    const rateCache = {};
    const stockCache = {};
    const inventoryRows = [];

    for (const asset of assets) {
      const fromInventory = prefillInventory?.items?.find((item) => item.asset?.toString() === asset._id.toString());
      let amountYen = 0;

      if (fromInventory) {
        amountYen = fromInventory.amountYen;
      } else {
        amountYen = await calculateAssetYen(asset, rateCache, stockCache);
      }

      inventoryRows.push({
        asset,
        amountYen
      });
    }

    const inventoryTitle = `${targetMonth.getFullYear()}年${String(targetMonth.getMonth() + 1).padStart(2, '0')}月の棚卸し`;

    res.render('assets/inventory', {
      inventoryRows,
      asset_cfs,
      targetMonthValue: formatYearMonth(targetMonth),
      targetInventory,
      latestInventory,
      inventoryTitle
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
    const targetMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const rawItems = Array.isArray(items) ? items : Object.values(items || {});
    const assetIds = rawItems.map((i) => i.asset).filter(Boolean);
    const assetDocs = await Asset.find({ group: groupId, _id: { $in: assetIds } });
    const assetMap = new Map(assetDocs.map((doc) => [doc._id.toString(), doc]));

    const snapshotItems = [];
    const totalByCf = { '金融資産': 0, '実物資産': 0, '無形資産': 0, '負債': 0 };
    let totalYen = 0;

    rawItems.forEach((input) => {
      const asset = assetMap.get(String(input.asset));
      if (!asset) return;
      const amountYen = Number(input.amountYen) || 0;

      snapshotItems.push({
        asset: asset._id,
        asset_cf: asset.asset_cf,
        asset_item: asset.asset_item,
        code: asset.code,
        content: asset.content,
        amountYen
      });

      totalYen += amountYen;
      if (totalByCf[asset.asset_cf] !== undefined) {
        totalByCf[asset.asset_cf] += amountYen;
      }
    });

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
      .populate('updatedBy', 'username displayname');

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

    const labels = [];
    const financialData = [];
    const physicalData = [];

    inventories.forEach((inv) => {
      const totalByCf = inv.totalByCf instanceof Map ? Object.fromEntries(inv.totalByCf) : inv.totalByCf || {};
      labels.push(`${inv.inventoryMonth.getFullYear()}年${String(inv.inventoryMonth.getMonth() + 1).padStart(2, '0')}月`);
      financialData.push(totalByCf['金融資産'] || 0);
      physicalData.push(totalByCf['実物資産'] || 0);
    });

    res.render('assets/historyGraph', {
      labels: JSON.stringify(labels),
      financialData: JSON.stringify(financialData),
      physicalData: JSON.stringify(physicalData)
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
        const assets = await Asset.find({ group: groupId }).sort({ entry_date: -1 });
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
        stockPrices
      });
  
    } catch (err) {
      console.error(err);
      res.status(500).send('エラーが発生しました。');
    }
});

module.exports = router;
