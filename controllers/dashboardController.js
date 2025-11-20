const Budget = require('../models/finance_ex_budget');
const Finance = require('../models/finance');
const mongoose = require('mongoose');
const { ObjectId } = require('mongodb');

//月次支出の項目別グラフの表示
exports.getMonthlyStackedExpenseData = async (req, res) => {
    const groupId = new mongoose.Types.ObjectId(req.session.activeGroupId);
    const selectedYear = parseInt(req.query.year) || new Date().getFullYear();
  
    // このグループの支出データがある年を取得
    const yearsRaw = await Finance.aggregate([
      {
        $match: {
          cf: '支出',
          group: groupId,
          date: { $exists: true }
        }
      },
      {
        $project: {
          year: { $year: "$date" }
        }
      },
      {
        $group: {
          _id: "$year"
        }
      },
      {
        $sort: { _id: -1 } // 新しい順に並べる（必要なら）
      }
    ]);

    // budgetから年を取得
    const budgetYearsRaw = await Budget.aggregate([
      { $match: { group: groupId } },
      { $group: { _id: "$year" } }
    ]);
  
    const financeYears = yearsRaw.map(doc => String(doc._id));
    const budgetYears = budgetYearsRaw.map(doc => doc._id);
    const availableYears = [...new Set([...financeYears, ...budgetYears])].sort((a, b) => b - a);
    console.log('availableYears:', availableYears);
    
    const startOfYear = new Date(`${selectedYear}-01-01T00:00:00.000Z`);
    const endOfYear = new Date(`${selectedYear + 1}-01-01T00:00:00.000Z`);
  
    const raw = await Finance.aggregate([
      {
        $match: {
          cf: '支出',
          group: groupId,
          date: { $gte: startOfYear, $lt: endOfYear }
        }
      },
      {
        $group: {
          _id: { month: "$month", item: "$expense_item" },
          total: { $sum: "$amount" }
        }
      },
      { $sort: { "_id.month": 1 } }
    ]);
  
    // display_order順でfinance_ex_budgetから取得
    const Budget = require('../models/finance_ex_budget');
    const budgetItems = await Budget.find({ group: groupId, year: String(selectedYear) }).sort({ display_order: 1 });
    const allItems = budgetItems
      .map(b => b.expense_item)
      .filter(item => item && typeof item === 'string' && item.trim() !== '');

    const selectedItems = req.query.items
      ? Array.isArray(req.query.items) ? req.query.items : [req.query.items]
      : null;

    // selectedItemsがある場合はallItemsの順序を保ったままフィルタリング
    const filteredItems = selectedItems
      ? allItems.filter(item => selectedItems.includes(item))
      : allItems;

    // monthlyDataをbudgetItemsのexpense_item順に作成
    const monthlyData = Array(12).fill(null).map(() => ({}));
    raw.forEach(({ _id, total }) => {
      const { month, item } = _id;
      monthlyData[month - 1][item] = total;
    });

    const datasets = filteredItems.map((item, index) => {
      const data = monthlyData.map(month => month[item] || 0);
      const color = getColorForItem(item);
      return {
        label: item,
        data,
        backgroundColor: color,
        stack: 'stack1'
      };
    });
  
    const labels = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

    res.render('dashboard/monthlyStackedChart', {
      labels,
      datasets,
      year: selectedYear,
      availableYears,
      allItems,
      selectedItems  // ← これが必須！
    });
};

//支出合計のグラフ表示
exports.getMonthlyExpenseData = async (req, res) => {
    const groupId = new mongoose.Types.ObjectId(req.session.activeGroupId);
    const monthlyData = await Finance.aggregate([
        {
        $match: {
            cf: '支出',
            group: groupId
        }
        },
        {
        $group: {
            _id: '$month', // `month` フィールドを直接使用
            totalAmount: { $sum: '$amount' }
        }
        },
        {
        $sort: { '_id': 1 }
        }
    ]);

    const data = Array(12).fill(0);
    monthlyData.forEach(item => {
        data[item._id - 1] = item.totalAmount;
    });

res.render('dashboard/monthlyChart', { data });
};

//年別支出グラフの表示
exports.getYearlyExpenseData = async (req, res) => {
    try {
      const groupId = new ObjectId(req.session.activeGroupId);
      const raw = await Finance.aggregate([
        {
          $match: {
            cf: '支出',
            group: groupId
          }
        },
        {
            $addFields: {
              yearInt: { $year: "$date" }
            }
        },
        {
          $group: {
            _id: { year: "$yearInt", item: "$expense_item" },
            total: { $sum: "$amount" }
          }
        },
        {
          $sort: { "_id.year": 1 }
        }
      ]);
  
      // データ整形など必要なら続けて追加
      const years = [...new Set(raw.map(item => item._id.year))].sort();
      const items = [...new Set(raw.map(item => item._id.item))];
      
      const datasets = items.map(item => {
        const data = years.map(year => {
          const entry = raw.find(r => r._id.year === year && r._id.item === item);
          return entry ? entry.total : 0;
        });
        return {
          label: item,
          data: data,
          backgroundColor: getColorForItem(item)
        };
      });
      
      res.render("dashboard/yearlyStackedChart", {
        labels: years,
        datasets: datasets
      });

    } catch (err) {
      console.error(err);
      res.status(500).send("Internal Server Error");
    }
};

//グラフ用の色を返す関数 getColorForItem
const itemColorMap = {};
const colorPalette = [
  '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40',
  '#8DD1E1', '#D1C4E9', '#B0BEC5', '#F48FB1', '#AED581', '#7986CB',
  '#FF8A65', '#A1887F', '#81D4FA', '#FFD54F', '#BA68C8', '#4DB6AC',
  '#E57373', '#90A4AE', '#F06292', '#64B5F6', '#81C784', '#9575CD'
];


let colorIndex = 0;

function getColorForItem(item) {
  if (!itemColorMap[item]) {
    itemColorMap[item] = colorPalette[colorIndex % colorPalette.length];
    colorIndex++;
  }
  return itemColorMap[item];
}

//月次支出の項目別グラフデータを生成する関数
module.exports.generateMonthlyStackedChartData = async function (groupId, selectedYear) {
  const result = await Finance.aggregate([
    {
      $match: {
        group: new mongoose.Types.ObjectId(groupId),
        cf: '支出',
        date: {
          $gte: new Date(`${selectedYear}-01-01`),
          $lte: new Date(`${selectedYear}-12-31`)
        }
      }
    },
    {
      $project: {
        month: { $month: "$date" },
        expense_item: 1,
        amount: 1
      }
    },
    {
      $group: {
        _id: {
          month: "$month",
          expense_item: "$expense_item"
        },
        total: { $sum: "$amount" }
      }
    },
    {
      $sort: { "_id.month": 1 }
    }
  ]);

  const labels = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
  const itemSet = new Set(result.map(r => r._id.expense_item));
  const datasets = [];

  itemSet.forEach(item => {
    const data = [];
    for (let m = 1; m <= 12; m++) {
      const found = result.find(r => r._id.month === m && r._id.expense_item === item);
      data.push(found ? found.total : 0);
    }
    datasets.push({
      label: item,
      data,
      stack: 'stack1',
      backgroundColor: getColorForItem(item)
    });
  });

  return { labels, datasets };
};