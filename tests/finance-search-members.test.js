const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {isGroupServiceEnabled}=require('../Utils/groupServices');
const members=[
  {_id:'yes',servicesByGroup:{group:{finance:true}}},
  {_id:'no',servicesByGroup:{group:{finance:false},other:{finance:true}}},
  {_id:'map-yes',servicesByGroup:new Map([['group',{finance:true}]])},
  {_id:'map-no',servicesByGroup:new Map([['group',{finance:false}]])},
  {_id:'legacy'},null
];
test('finance membership respects the selected groups settings for plain objects and Mongoose maps',()=>{
  assert.deepEqual(members.filter(member=>isGroupServiceEnabled(member,'group','finance')).map(member=>member._id),['yes','map-yes','legacy']);
  assert.equal(isGroupServiceEnabled(members[1],'other','finance'),true);
});
const source=fs.readFileSync(require.resolve('../routes/finance'),'utf8');
for(const route of ["router.get('/search'","router.post('/search'","router.get('/search/results'"])test(`${route} only builds user/payment choices from finance-enabled members`,()=>{
  const start=source.indexOf(route);const from=source.indexOf('const members =',start);const end=source.indexOf(';',source.indexOf('const memberIds =',from))+1;
  const context={group:{members},activeGroupId:'group',isGroupServiceEnabled};
  vm.runInNewContext(source.slice(from,end)+'\nthis.ids=memberIds;',context);
  assert.deepEqual(Array.from(context.ids),['yes','map-yes','legacy']);
});
