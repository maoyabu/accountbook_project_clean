const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ejs=require('ejs'),cheerio=require('cheerio');
const {buildPaymentSearchOptions}=require('../Utils/paymentSearchOptions');
const paymentItems=[{paymentItem:'現金',user:{displayname:'太郎'}},{paymentItem:'現金',user:{displayname:'花子'}},{paymentItem:'現金',user:{displayname:'太郎'}},{paymentItem:'カード',user:{username:'本人'}}];
test('payment search options group owners while retaining payment values and deduplicate within each owner',()=>{
  const options=buildPaymentSearchOptions(paymentItems,['Please Choice','現金','カード']);
  assert.equal(options.filter(option=>option.value==='現金').length,2);
  assert.deepEqual(options.filter(option=>option.value==='現金').map(option=>option.label).sort(),['現金（太郎）','現金（花子）'].sort());
  assert.deepEqual(buildPaymentSearchOptions([],['旧カード']),[{value:'旧カード',label:'旧カード'}]);
});
for(const view of ['search','search_results'])test(`${view} submits only the payment name, renders escaped owners and retains the selected filter`,()=>{
  const source=fs.readFileSync(`views/finance/${view}.ejs`,'utf8');const fragment=source.match(/<select name="payment_type"[\s\S]*?<\/select>/)[0];
  const paymentSearchOptions=buildPaymentSearchOptions([...paymentItems,{paymentItem:'<カード>',user:{displayname:'<使用者>'}}],['Please Choice','現金','カード','<カード>']);
  const html=ejs.render(fragment,{paymentSearchOptions,pay_cfs:[],filters:{payment_type:'現金'}});const $=cheerio.load(html);
  assert.equal($('option[value="現金"]').length,2);assert.equal($('option[value="現金"]').first().text().includes('（'),true);
  assert.equal($('option').filter((_,option)=>$(option).val().includes('（')).length,0);
  assert.ok(html.includes('&lt;使用者&gt;'));
  if(view==='search_results')assert.equal($('option:selected').val(),'現金');
});

test('logged-in user is first, other owners stay together, and per-user display_order includes zero',()=>{
  const owner=(id,name)=>({_id:id,displayname:name});
  const me=owner('me','わたし'),a=owner('a','あおい'),b=owner('b','いとう');
  const options=buildPaymentSearchOptions([
    {paymentItem:'カード',user:b,display_order:0},
    {paymentItem:'現金',user:me,display_order:2},
    {paymentItem:'VISA',user:a,display_order:3},
    {paymentItem:'カード',user:me,display_order:0},
    {paymentItem:'現金',user:a,display_order:0},
    {paymentItem:'現金',user:me,display_order:4}
  ],['Please Choice','VISA','現金','カード','旧種別'],'me');
  assert.deepEqual(options.map(option=>option.label),['すべて','カード（わたし）','現金（わたし）','現金（あおい）','VISA（あおい）','カード（いとう）','旧種別']);
  assert.deepEqual(options.map(option=>option.value),['Please Choice','カード','現金','現金','VISA','カード','旧種別']);
});
