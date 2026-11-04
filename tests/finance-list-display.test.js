const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ejs=require('ejs');
const cheerio=require('cheerio');
const path=require('node:path');
const {resolveFinanceListDisplay}=require('../Utils/financeListDisplay');
test('display controls normalize query values and restrict sort fields and limits',()=>{
  assert.deepEqual(resolveFinanceListDisplay({sortOrder:'update_date',limit:'50'}),{sortOrder:'update_date',displayLimit:50,sortCriteria:{update_date:-1}});
  assert.deepEqual(resolveFinanceListDisplay({sortOrder:['update_date','date'],limit:['100','20']}),{sortOrder:'date',displayLimit:20,sortCriteria:{date:-1}});
  assert.deepEqual(resolveFinanceListDisplay({sortOrder:{$ne:''},limit:'9999'},'update_date'),{sortOrder:'update_date',displayLimit:20,sortCriteria:{update_date:-1}});
});
for(const view of ['list','search_results'])test(`${view} keeps sort and limit outside closed filters and associated with the filter form`,()=>{
  const filename=path.resolve('views/finance',view+'.ejs');
  const html=ejs.render(fs.readFileSync(filename,'utf8'),{layout(){},page:'search',finances:[],count:125,displayLimit:50,sortOrder:'date',currentUser:{_id:'u'},selectedFilters:{},filterOptions:{},filters:{keyword:'買い物',from:'2026-11-01'},la_cfs:[],ex_cfs:[],in_items:[],dedu_cfs:[],saving_cfs:[],pay_cfs:[],whos:[]},{filename});
  const $=cheerio.load(html);
  const sort=$('select[name="sortOrder"]'),limit=$('select[name="limit"]');
  assert.equal(sort.length,1);assert.equal(limit.length,1);assert.equal(sort.closest('details').length,0);assert.equal(limit.closest('details').length,0);
  assert.equal(sort.attr('form'),limit.attr('form'));assert.equal($('#'+sort.attr('form')).attr('method'),'GET');
  assert.equal(sort.find(':selected').val(),'date');assert.equal(limit.find(':selected').val(),'50');
  assert.equal($('details[open]').length,0);
  if(view==='search_results'){assert.equal($('[name="keyword"]').val(),'買い物');assert.equal($('[name="from"]').val(),'2026-11-01');}
});
