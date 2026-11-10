const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.value = ''; this.textContent = ''; this.classes = new Set(); this.classList = {add: x => this.classes.add(x), remove: x => this.classes.delete(x), toggle: (x,on) => on ? this.classes.add(x) : this.classes.delete(x), contains: x => this.classes.has(x)}; }
  append(child) { this.children.push(child); }
  add(child) { this.append(child); }
  replaceChildren() { this.children = []; }
  setAttribute(name,value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name,fn) { this.handlers[name] = fn; }
  querySelector() { return this.children.find(x => ['input','select'].includes(x.tag)); }
  focus() {}
  async fire(event = 'click') { await this.handlers[event]?.({preventDefault(){}}); }
}
const initial = {groupId:'g',userId:'u',date:'2026-11-03',cf:'',category:'',sub_tag:'',content:'',amount:'',payment_type:''};
const options = {userId:'u',groups:[{id:'g',name:'家族'}],users:[{id:'u',name:'本人'}],categories:{支出:['食費'],収入:['給与'],控除:['税'],貯蓄:['預金']},payments:['現金'],commonTags:[]};
function setup(mode='new', entryMode='step', conversation=false, overrides={}) {
  const ids = {}; const $ = name => ids[name] ||= new Element(); const calls = [];
  const values = mode === 'edit' ? {...initial,cf:'支出',category:'食費',content:'昼食',amount:500,payment_type:'現金'} : initial;
  $('compactData').textContent = JSON.stringify({mode,entryMode,conversation,id:'record',values,options,tagEnabled:true,returnTo:'/finance/list',...overrides});
  const window = {addEventListener(){},location:{origin:'http://localhost'},confirm:()=>true}; window.parent = window;
  const runtime = {
    document:{getElementById:$,createElement:tag=>new Element(tag)}, Option:function(text,value){this.textContent=text;this.value=value;}, URL, URLSearchParams,
    bootstrap:{Modal:{getOrCreateInstance:()=>({show(){},hide(){}})}}, window,
    fetch:async(url,params)=>{calls.push({url,params});return {ok:true,json:async()=>params?.method === 'POST' ? {ok:true,continueUrl:'/finance/entry-step?from=saved'} : {ok:true,options:overrides.options || options}};}
  };
  if (conversation) vm.runInNewContext(fs.readFileSync('public/js/financeConversation.js','utf8'),runtime);
  vm.runInNewContext(fs.readFileSync('public/js/financeCompact.js','utf8'),runtime);
  return {$,calls,window};
}
test('seven steps collapse to text rows, allow field modal correction and save-and-continue',async()=>{
  const {$,calls,window}=setup();
  const input=async value=>{
    const host=$('compactStepField'); const field=host.querySelector();
    if(field.type === 'hidden') return host.children[1].children.find(button=>button.textContent===value).fire();
    else field.value=value;
    await $('compactStepForm').fire('submit');
  };
  await input('2026-11-03'); await input('支出'); await input('食費');
  await $('compactSkip').fire(); await input('昼食'); await input('1200'); await input('現金');
  assert.equal($('compactRows').children.length,7); assert.equal($('compactStepPanel').classList.contains('d-none'),true);
  await $('compactRows').children[5].fire(); $('compactModalField').querySelector().value='1500'; await $('compactModalForm').fire('submit');
  assert.match($('compactRows').children[5].children[1].textContent,/1,500/);
  await $('compactContinue').fire(); const payload=JSON.parse(calls.at(-1).params.body);
  assert.equal(payload.values.amount,'1500'); assert.equal(payload.values.sub_tag,''); assert.equal(window.location.href,'http://localhost/finance/entry-step?from=saved');
});
test('editing starts in compact review and user changes clear previous payment',async()=>{
  const {$,calls}=setup('edit'); assert.equal($('compactRows').children.length,7);
  assert.equal($('compactIdentity').children[0].tag,'button');
  await $('compactIdentity').children[1].fire(); await $('compactModalField').children[1].children[0].fire(); await $('compactModalForm').fire('submit');
  assert.match(calls[0].url,/userId=u/); assert.equal($('compactRows').children[6].children[1].textContent,'未入力');
});
test('compact template safely embeds user content in JSON',()=>{
  const content='</script><script>alert(1)</script>';
  const html=ejs.render(fs.readFileSync('views/finance/compact.ejs','utf8'),{layout(){},embedded:false,compactData:{mode:'new',values:{...initial,content},options}});
  const json=html.match(/id="compactData">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).values.content,content); assert.equal(json.includes('</script>'),false);
});

test('choice tags show the current selection and switch to only one selected tag',async()=>{
  const {$}=setup('edit');
  await $('compactRows').children[1].fire();
  const host=$('compactModalField');
  assert.equal(host.querySelector().type,'hidden');
  const buttons=host.children[1].children;
  assert.deepEqual(buttons.map(button=>button.textContent),['支出','収入','控除','貯蓄']);
  assert.equal(buttons[0].getAttribute('aria-pressed'),'true');
  await buttons[1].fire();
  assert.equal(buttons[0].getAttribute('aria-pressed'),'false');
  assert.equal(buttons[1].getAttribute('aria-pressed'),'true');
  await $('compactModalForm').fire('submit');
  assert.equal($('compactRows').children[1].children[1].textContent,'収入');
  assert.equal($('compactRows').children[2].children[1].textContent,'未入力');
  await $('compactRows').children[2].fire();
  assert.deepEqual($('compactModalField').children[1].children.map(button=>button.textContent),['給与']);
});

test('list mode shows all editable fields, preserves values and reaches the same confirmation and save',async()=>{
  const {$,calls}=setup('new','list');
  assert.equal($('compactListPanel').classList.contains('d-none'),false);
  assert.equal($('compactStepPanel').classList.contains('d-none'),true);
  const host = key => $('compactListFields').children[['date','cf','category','sub_tag','content','amount','payment_type'].indexOf(key)].children[1];
  const choose = async(key,value)=>{await host(key).children[1].children.find(button=>button.textContent===value).fire();};
  const type = async(key,value)=>{host(key).querySelector().value=value;await host(key).querySelector().fire('input');};
  assert.equal($('compactListFields').children.length,7);
  await type('content','昼食'); await type('amount','850');
  await choose('cf','支出'); await choose('category','食費'); await choose('payment_type','現金');
  assert.equal(host('content').querySelector().value,'昼食'); assert.equal(host('amount').querySelector().value,'850');
  await $('compactListForm').fire('submit');
  assert.equal($('compactRows').children.length,7); assert.equal($('compactListPanel').classList.contains('d-none'),true);
  await $('compactListBack').fire(); assert.equal(host('content').querySelector().value,'昼食');
  await $('compactListForm').fire('submit'); await $('compactSave').fire();
  assert.equal(JSON.parse(calls.at(-1).params.body).values.amount,'850');
});

test('conversation uses shared completed rows and confirmation and continues with previous record',async()=>{
  const {$,calls,window}=setup('new','step',true);
  const enter=async value=>{ $('compactStepField').querySelector().value=value; await $('compactStepForm').fire('submit'); };
  await enter('2026-11-03'); assert.equal($('compactRows').children.length,1);
  await enter('支出'); await enter('食費'); await $('compactSkip').fire(); await enter('夕食'); await enter('900'); await enter('現金');
  assert.equal($('compactRows').children.length,7); assert.equal($('compactConfirm').classList.contains('d-none'),false);
  await $('compactContinue').fire(); assert.equal(calls.filter(call=>call.params?.method==='POST').length,1);
  assert.equal(window.location.href,'http://localhost/finance/entry-conversation?from=saved');
});

for (const [entryMode, conversation] of [['step',false],['list',false],['step',true]]) {
  test(`continuation uses modal-only confirmation (${entryMode}, voice=${conversation})`,async()=>{
    const {$,calls}=setup('new',entryMode,conversation,{continuing:true,reviewing:true,values:{...initial,cf:'支出',category:'食費'}});
    assert.equal($('compactRows').children.length,7);
    for (const panel of ['compactStepPanel','compactListPanel','compactListBack']) assert.equal($(panel).classList.contains('d-none'),true);
    assert.equal($('compactConfirm').classList.contains('d-none'),false);
    await $('compactSave').fire();assert.equal(calls.length,0);
    assert.match($('compactError').textContent,/内容/);
    for(const [index,value] of [[4,'夕食'],[5,'980'],[6,'現金']]){
      await $('compactRows').children[index].fire();
      const host=$('compactModalField');
      if(host.querySelector().type==='hidden') await host.children[1].children.find(button=>button.textContent===value).fire();
      else host.querySelector().value=value;
      await $('compactModalForm').fire('submit');
    }
    await $('compactSave').fire();
    assert.equal(calls.at(-1).url,'/finance/entry-step');
    const saved=JSON.parse(calls.at(-1).params.body).values;
    assert.equal(saved.content,'夕食');assert.equal(saved.amount,'980');assert.equal(saved.date,'2026-11-03');
  });
}

test('selecting choices advances once through category and tags and payment opens review without saving',async()=>{
  const {$,calls}=setup('new','step',false,{options:{...options,commonTags:[{category:'食費',tags:[{name:'食品'}]}]}});
  await $('compactStepForm').fire('submit'); // Date is prefilled.
  const choose=async(label,groupIndex=1)=>{await $('compactStepField').children[groupIndex].children.find(button=>button.textContent===label).fire();};
  assert.equal($('compactStepTitle').textContent,'収支区分');
  const oldCf=$('compactStepField').children[1].children[0];await oldCf.fire();
  assert.equal($('compactStepTitle').textContent,'詳細区分');await oldCf.fire();assert.equal($('compactStepTitle').textContent,'詳細区分');
  await choose('食費');assert.equal($('compactStepTitle').textContent,'タグ');
  await choose('食品',2);assert.equal($('compactStepTitle').textContent,'内容');
  $('compactStepField').querySelector().value='朝食';await $('compactStepForm').fire('submit');
  $('compactStepField').querySelector().value='500';await $('compactStepForm').fire('submit');
  await choose('現金');assert.equal($('compactConfirm').classList.contains('d-none'),false);
  assert.equal(calls.some(call=>call.params?.method==='POST'),false);
  assert.equal($('compactRows').children[3].children[1].textContent,'食品');
});
test('conversation date choice advances automatically to income/expense selection',async()=>{
  const {$}=setup('new','step',true);
  await $('compactStepField').children[1].children[0].fire();
  assert.equal($('compactStepTitle').textContent,'収支区分');assert.equal($('compactRows').children.length,1);
});

test('disabled tag input is omitted from list and editing screens', () => {
  const list = setup('new','list',false,{tagEnabled:false});
  assert.equal(list.$('compactListFields').children.length,6);
  assert.equal(list.$('compactListFields').children.some(section => section.children[0].textContent === 'タグ'),false);
  const edit = setup('edit','step',false,{tagEnabled:false});
  assert.equal(edit.$('compactRows').children.length,6);
  assert.equal(edit.$('compactRows').children.some(row => row.children[0].textContent === 'タグ'),false);
});
test('disabled tag input automatically advances from category to content', async () => {
  const {$} = setup('new','step',false,{tagEnabled:false});
  await $('compactStepForm').fire('submit');
  await $('compactStepField').children[1].children[0].fire();
  await $('compactStepField').children[1].children[0].fire();
  assert.equal($('compactStepTitle').textContent,'内容');
  assert.equal($('compactProgress').textContent,'STEP 4 / 6');
  assert.equal($('compactSkip').classList.contains('d-none'),true);
});
