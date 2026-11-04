const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ExcelJS = require('exceljs');
const ejs = require('ejs');
const cheerio = require('cheerio');
const { sortYearlyExpenseItems, applyYearlyExpenseItemBorders } = require('../Utils/yearlyExpenseOrder');
const source = fs.readFileSync(require.resolve('../routes/output'), 'utf8');
const groups = [
  { name: '生活', display_order: 0, item_names: ['食品', '日用品'] },
  { name: '移動', display_order: 1, item_names: ['電車', '車'] }
];
const budgets = [
  { expense_item: '車', display_order: 0, budget: 500 },
  { expense_item: '未分類', display_order: 0, budget: 600 },
  { expense_item: '食品', display_order: 2, budget: 100 },
  { expense_item: '電車', display_order: 1, budget: 300 },
  { expense_item: '日用品', display_order: 0, budget: 200 }
];
const expected = ['日用品', '食品', '車', '電車', '未分類'];
test('category rank precedes item rank, preserves zero, and leaves inputs unchanged', () => {
  const items = budgets.map(b => b.expense_item), original = [...items];
  assert.deepEqual(sortYearlyExpenseItems(items, budgets, groups), expected);
  assert.deepEqual(items, original);
  assert.deepEqual(sortYearlyExpenseItems(items, budgets, []), ['車','未分類','日用品'].sort((a,b)=>a.localeCompare(b,'ja')).concat(['電車','食品']));
});
const summaryHelper = source.slice(source.indexOf('const buildYearlyExpenseCategorySummaries ='), source.indexOf('async function fetchItemsByYear'));
const routesSource = source.slice(source.indexOf("router.get('/dashboard/yearly-m'"), source.indexOf('//支出計',source.indexOf("router.get('/dashboard/yearly-m'")));
async function run(route, categorySummary, tagSummary) {
  const routes = {}; let sheet, locals;
  class Workbook extends ExcelJS.Workbook {
    constructor() { super(); this.xlsx.writeFile = async () => { sheet = this.worksheets[0]; }; }
  }
  vm.runInNewContext(summaryHelper + routesSource, {
    router: {get:(path,...handlers)=> { routes[path]=handlers.at(-1); }},
    require, process:{env:{NODE_ENV:'production'}}, ExcelJS:{Workbook},
    fs:{unlink(){}}, console, isLoggedIn(){}, sortYearlyExpenseItems, applyYearlyExpenseItemBorders,
    mongoose: {Types:{ObjectId:class {constructor(id){this.id=id;}}}},
    Finance:{aggregate:async()=>budgets.map(b=>({_id:{month:9,cf:'支出',expense_item:b.expense_item,sub_tag:'テスト'},total:10}))},
    FinanceExBudget:{find:async()=>budgets},
    fetchItemsByYear:async()=>[], fetchExpenseCategoryGroups:async()=>groups,
    getGroupFiscalStartMonth:async()=>9,
    resolveYearlySummaryPeriod:()=>({year:2026,defaultYear:2026,selectedMonth:11,fiscalRange:{start:new Date('2026-09-01'),end:new Date('2026-12-01')},fiscalMonths:[9,10,11],monthOptions:[9,10,11],budgetMonthCount:3}),
    resolveDashboardTagSummary:()=>tagSummary, resolveDashboardCategorySummary:()=>categorySummary
  });
  const res={render(view,data){locals=data;},download(){},status(code){assert.fail(`Route returned ${code}`);},send(){}};
  await routes[route]({session:{activeGroupId:'group',groupName:'家族'},user:{_id:'user',displayname:'本人'},query:{}},res);
  return {locals,sheet};
}
for (const scope of ['m','g']) for (const categorySummary of [false,true]) for (const tagSummary of [false,true]) {
  test(`${scope}: screen and actual Excel rows agree (category=${categorySummary}, tags=${tagSummary})`,async()=>{
    const screen=await run(`/dashboard/yearly-${scope}`,categorySummary,tagSummary);
    const excel=await run(`/dashboard/yearly-${scope}-exls`,categorySummary,tagSummary);
    assert.deepEqual(Array.from(screen.locals.ex_cfs), expected);
    const rows=[];excel.sheet.eachRow(row=>{if(expected.includes(row.getCell(1).value))rows.push(row);});
    assert.deepEqual(rows.map(row=>row.getCell(1).value),expected);
    for(const row of rows) { assert.equal(row.getCell(2).value,budgets.find(b=>b.expense_item===row.getCell(1).value).budget);assert.equal(row.getCell(3).value,10); }
    const html = ejs.render(fs.readFileSync(require.resolve('../views/dashboard/yearly.ejs'),'utf8'), {layout(){}, ...screen.locals});
    const $ = cheerio.load(html);
    for (const row of rows) {
      const item = row.getCell(1).value;
      const assigned = groups.some(group=>group.item_names.includes(item));
      const endRow = excel.sheet.getRow(row.number + (tagSummary ? 1 : 0));
      if (assigned) {
        for (let column=1;column<=excel.sheet.columnCount;column++) assert.equal(endRow.getCell(column).border.bottom.style,'dotted');
        if(tagSummary) assert.notEqual(row.getCell(3).border?.bottom?.style,'dotted');
      } else assert.notEqual(endRow.getCell(3).border?.bottom?.style,'dotted');
      const screenRow = $('tbody tr').filter((_,tr)=>$(tr).children('td').toArray().some(td=>$(td).text().trim()===item)).last();
      assert.equal(screenRow.length,1);
      assert.equal(screenRow.hasClass('yearly-expense-item-end'),assigned&&!tagSummary);
      if(tagSummary) assert.equal(screenRow.next().hasClass('yearly-expense-item-end'),assigned);
    }
    assert.equal(rows[0].getCell(1).border.left.style,'thick');

  });
}

test('annual item and tag rows use the second matching parent color, or the first when only one matches', async () => {
  const {locals}=await run('/dashboard/yearly-g',true,true);
  locals.expenseCategorySummaries = [
    {...locals.expenseCategorySummaries[0],name:'第一',itemNames:['食品','日用品']},
    {...locals.expenseCategorySummaries[1],name:'第二',itemNames:['食品']},
    {...locals.expenseCategorySummaries[1],name:'第三',itemNames:['食品']}
  ];
  const html=ejs.render(fs.readFileSync(require.resolve('../views/dashboard/yearly.ejs'),'utf8'),{layout(){},...locals});
  const $=cheerio.load(html);
  const rowFor=item=>$('tbody tr').filter((_,tr)=>$(tr).children('td').toArray().some(td=>$(td).text().trim()===item)).last();
  assert.match(rowFor('食品').attr('style'),/#C5D6A0/);
  assert.match(rowFor('食品').next().attr('style'),/#C5D6A0/);
  assert.match(rowFor('日用品').attr('style'),/#D7E8CF/);
  assert.equal(rowFor('未分類').hasClass('yearly-category-row'),false);
  assert.equal(html.includes('#3C8D2F'),false);
});
