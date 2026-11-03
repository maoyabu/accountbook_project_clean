const test = require('node:test');
const assert = require('node:assert/strict');
const createRouter = require('../routes/financeCompact');
const { validDate, validateValues } = require('../Utils/financeCompactState');
const group = '111111111111111111111111', user = '222222222222222222222222', other = '333333333333333333333333', record = '444444444444444444444444';
function fixture() {
  const saved = [], paymentQueries = [], preferences = [];
  let duplicate = null;
  class Finance {
    constructor(data) { Object.assign(this, data); this._id ||= record; }
    async save() { saved.push(this); return this; }
    toObject() { return { ...this }; }
    static async findById() { return source; }
    static async findOne() { return duplicate; }
  }
  const source = new Finance({ group, user, date: new Date('2026-11-03'), cf: '支出', expense_item: '食費', content: '元', amount: 100, payment_type: '現金', memo: '保持', tags: [{name:'明細'}] });
  const router = createRouter({ Finance, FinanceUser: { async findByIdAndUpdate(id, update) { preferences.push({id, update}); } }, PaymentItem: { find(query) { paymentQueries.push(query); return { sort: async () => [{ paymentItem: query.user === user ? '現金' : 'カード' }] }; } },
    isLoggedIn: (_req, _res, next) => next(), getFinanceEditableGroupsForUser: async () => ({ availableGroupIds: new Set([group]), availableGroups: [{_id:group,group_name:'家族'}] }),
    buildFinanceFormOptions: async () => ({ allUsers: [{_id:user,displayname:'本人'}, {_id:other,displayname:'家族'}], ex_cfs:['食費'], in_items:['給与'], dedu_cfs:['税'], saving_cfs:['預金'], common_tags:[] }),
    getGroupFiscalStartMonth: async () => 1, resolveFiscalYearForValue: () => 2026, buildDuplicateQuery: value => ({content:value.content}), sanitizeReturnPath: (value, fallback) => fallback, logAction: async () => {} });
  async function call(method, path, extra = {}) {
    const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
    const req = { user: {_id:user,financeTagRegistrationEnabled:true}, session:{activeGroupId:group}, query:{}, params:{}, body:{}, flash(){}, ...extra };
    const res = { code:200, status(code){this.code=code;return this;}, send(value){this.data=value;return this;}, json(value){this.data=value;return this;}, render(view,data){this.view=view;this.data=data;}, redirect(url){this.url=url;} };
    await layer.route.stack.at(-1).handle(req,res,err=>{throw err;}); return res;
  }
  return { call, saved, source, paymentQueries, preferences, setDuplicate(value){duplicate=value;} };
}
const values = () => ({groupId:group,userId:user,date:'2026-11-03',cf:'支出',category:'食費',sub_tag:'食品',content:'昼食',amount:'1200',payment_type:'現金'});
test('strict date and numeric/category validation', () => {
  assert.equal(validDate('2026-02-30'),false);
  assert.equal(validDate('2026-11-03'),true);
  const errors = validateValues({...values(),cf:'constructor',amount:''}, {categories:{支出:['食費']},payments:['現金']});
  assert.ok(errors.cf && errors.category && errors.amount);
});
test('new registration forces logged in identity and saves exactly one complete record',async()=>{
  const f=fixture(); const res=await f.call('post','/entry-step',{body:{values:{...values(),userId:other,groupId:other}}});
  assert.equal(res.code,200); assert.equal(f.saved.length,1); assert.equal(f.saved[0].user,user); assert.equal(f.saved[0].group,group);
  assert.equal(f.saved[0].amount,1200); assert.match(res.data.continueUrl,/from=/); assert.deepEqual(f.paymentQueries[0],{group,user});
});
test('continue carries only date and categories, without creating a placeholder',async()=>{
  const f=fixture(); const res=await f.call('get','/entry',{query:{from:record}});
  const data=res.data.compactData; assert.equal(data.continuing,true); assert.equal(data.values.category,'食費');
  for(const key of ['sub_tag','content','amount','payment_type']) assert.equal(data.values[key],'');
  assert.equal(f.saved.length,0);
});
test('payment options belong only to selected user and reject another users payment',async()=>{
  const f=fixture(); const res=await f.call('post','/:id/compact',{params:{id:record},body:{values:{...values(),userId:other}}});
  assert.equal(res.code,400); assert.ok(res.data.errors.payment_type); assert.equal(f.saved.length,0);
  assert.deepEqual(f.paymentQueries[0],{group,user:other});
});
test('updates preserve existing memo/details; duplication does not overwrite source',async()=>{
  const f=fixture(); await f.call('post','/:id/compact',{params:{id:record},body:{values:values()}});
  assert.equal(f.source.memo,'保持'); assert.deepEqual(f.source.tags,[{name:'明細'}]); assert.equal(f.source.content,'昼食');
  await f.call('post','/:id/compact',{params:{id:record},body:{values:{...values(),content:'複製'},copy:true}});
  assert.equal(f.source.content,'昼食'); assert.equal(f.saved[1].content,'複製');
});
test('invalid groups, categories and duplicate saves cannot silently pass',async()=>{
  const f=fixture(); let res=await f.call('post','/:id/compact',{params:{id:record},body:{values:{...values(),groupId:other}}}); assert.equal(res.code,403);
  res=await f.call('post','/entry-step',{body:{values:{...values(),category:'未知'}}}); assert.equal(res.code,400);
  f.setDuplicate({}); res=await f.call('post','/entry-step',{body:{values:values()}}); assert.equal(res.code,409); assert.equal(f.saved.length,0);
  res=await f.call('post','/entry-step',{body:{values:values(),confirmDuplicate:true}}); assert.equal(res.code,200); assert.equal(f.saved.length,1);
});

test('old step URL redirects to the single new entry URL preserving continuation', async () => {
  const f=fixture(); const res=await f.call('get','/entry-step',{query:{from:record,modal:'1',returnTo:'/finance/list'}});
  assert.match(res.url,/^\/finance\/entry\?from=/); assert.ok(res.url.includes('modal=1'));
});
test('conversation input confirms in the new compact screen without saving prematurely', async () => {
  const f=fixture(); const res=await f.call('post','/entry',{body:{finance:{date:'2026-11-03',cf:'支出',expense_item:'食費',content:'昼食',amount:'800',payment_type:'現金',user:other}}});
  assert.equal(res.view,'finance/compact'); assert.equal(res.data.compactData.reviewing,true);
  assert.equal(res.data.compactData.values.userId,user); assert.equal(res.data.compactData.values.category,'食費'); assert.equal(f.saved.length,0);
});

test('entry mode defaults to step and uses the logged in users list preference',async()=>{
  const f=fixture(); let res=await f.call('get','/entry'); assert.equal(res.data.compactData.entryMode,'step');
  res=await f.call('get','/entry',{user:{_id:user,financeEntryMode:'list'}}); assert.equal(res.data.compactData.entryMode,'list');
  res=await f.call('get','/entry',{user:{_id:user,financeEntryMode:'list'},query:{from:record}}); assert.equal(res.data.compactData.entryMode,'list'); assert.equal(res.data.compactData.values.content,'');
});
test('input preference saves only for the logged in user and rejects unknown modes',async()=>{
  const f=fixture(); let res=await f.call('post','/budget/entry-mode',{body:{financeEntryMode:'list',userId:other}});
  assert.equal(res.url,'/finance/budget'); assert.deepEqual(f.preferences,[{id:user,update:{financeEntryMode:'list'}}]);
  res=await f.call('post','/budget/entry-mode',{body:{financeEntryMode:'invalid'}}); assert.equal(res.code,400); assert.equal(f.preferences.length,1);
});

test('conversation forces step flow and inherits only date and categories on continuation',async()=>{
  const f=fixture(); const res=await f.call('get','/entry-conversation',{user:{_id:user,financeEntryMode:'list'},query:{from:record}});
  assert.equal(res.view,'finance/compact'); const config=res.data.compactData;
  assert.equal(config.conversation,true); assert.equal(config.entryMode,'step'); assert.equal(config.values.category,'食費');
  for(const field of ['sub_tag','content','amount','payment_type']) assert.equal(config.values[field],'');
  assert.equal(f.saved.length,0);
});
