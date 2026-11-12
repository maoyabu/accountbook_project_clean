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
  const modal = {shown:false,show(){this.shown=true;},hide(){this.shown=false;}};
  const values = mode === 'edit' ? {...initial,cf:'支出',category:'食費',content:'昼食',amount:500,payment_type:'現金'} : initial;
  $('compactData').textContent = JSON.stringify({mode,entryMode,conversation,id:'record',values,options,tagEnabled:true,returnTo:'/finance/list',...overrides});
  const window = {addEventListener(){},location:{origin:'http://localhost'},confirm:()=>true}; window.parent = window;
  const runtime = {
    document:{getElementById:$,createElement:tag=>new Element(tag)}, Option:function(text,value){this.textContent=text;this.value=value;}, URL, URLSearchParams,
    bootstrap:{Modal:{getOrCreateInstance:()=>modal}}, window,
    fetch:async(url,params)=>{calls.push({url,params});return {ok:true,json:async()=>params?.method === 'POST' ? {ok:true,continueUrl:'/finance/entry-step?from=saved'} : {ok:true,options:overrides.options || options}};}
  };
  if (conversation) vm.runInNewContext(fs.readFileSync('public/js/financeConversation.js','utf8'),runtime);
  vm.runInNewContext(fs.readFileSync('public/js/financeCompact.js','utf8'),runtime);
  return {$,calls,window,modal};
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

test('list mode starts with date only and applies selected fields through the edit modal',async()=>{
  const {$,calls}=setup('new','list');
  assert.equal($('compactStepPanel').classList.contains('d-none'),true);
  assert.equal($('compactConfirm').classList.contains('d-none'),false);
  const row = key => $('compactRows').children.find(item=>item.children[0].textContent===key);
  assert.equal($('compactRows').children.length,6);
  assert.equal(row('年月日').children[1].textContent,initial.date);
  assert.equal(row('詳細区分'),undefined);
  for (const item of $('compactRows').children.slice(1)) assert.equal(item.children[1].textContent,'');
  const apply = async(label,value)=>{
    await row(label).fire();
    const host=$('compactModalField');
    if(host.querySelector().type==='hidden') await host.children[1].children.find(button=>button.textContent===value).fire();
    else host.querySelector().value=value;
    await $('compactModalForm').fire('submit');
  };
  await row('収支区分').fire();
  await $('compactModalField').children[1].children[0].fire();
  assert.equal(row('詳細区分').children[1].textContent,'');
  assert.equal(row('収支区分').children[1].textContent,'支出');
  assert.equal(row('詳細区分').children[1].textContent,'');
  await apply('詳細区分','食費'); await apply('タグ','食品');
  await apply('収支区分','収入');
  assert.equal(row('詳細区分').children[1].textContent,'');
  assert.equal(row('タグ').children[1].textContent,'');
  await apply('詳細区分','給与');
  await $('compactSave').fire(); assert.equal(calls.length,0);
  assert.match($('compactError').textContent,/内容/);
  await apply('内容','給与振込'); await apply('金額','850'); await apply('支払種別','現金');
  await $('compactSave').fire();
  const saved=JSON.parse(calls.at(-1).params.body).values;
  assert.equal(saved.amount,'850'); assert.equal(saved.cf,'収入'); assert.equal(saved.category,'給与');
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
    for (const panel of ['compactStepPanel']) assert.equal($(panel).classList.contains('d-none'),true);
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
  assert.equal(list.$('compactRows').children.length,5);
  assert.equal(list.$('compactRows').children.some(row => row.children[0].textContent === 'タグ'),false);
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

for (const [mode, entryMode] of [['new','list'], ['new','step'], ['edit','step']]) {
  test(`modal selections close immediately and text waits for apply (${mode}, ${entryMode})`, async () => {
    const {$,modal,calls} = setup(mode,entryMode,false,{
      reviewing:true,
      values:{...initial,cf:'支出',category:'食費',content:'昼食',amount:'500',payment_type:'現金'},
      options:{...options,commonTags:[{category:'食費',tags:[{name:'食品'}]}]}
    });
    const row = label => $('compactRows').children.find(item=>item.children[0].textContent===label);
    for (const [label,value] of [['収支区分','支出'],['詳細区分','食費'],['タグ','食品'],['支払種別','現金']]) {
      await row(label).fire();
      assert.equal(modal.shown,true);
      const host=$('compactModalField');
      const chips=host.children[label==='タグ' ? 2 : 1];
      await chips.children.find(button=>button.textContent===value).fire();
      assert.equal(modal.shown,false);
      assert.equal(row(label).children[1].textContent,value);
    }
    for (const [label,value,expected] of [['内容','夕食','夕食'],['金額','850','¥850']]) {
      const previous=row(label).children[1].textContent;
      await row(label).fire();
      const input=$('compactModalField').querySelector(); input.value=value;
      await input.fire('input'); await input.fire('change');
      assert.equal(modal.shown,true);
      assert.equal(row(label).children[1].textContent,previous);
      assert.equal($('compactModalApply').classList.contains('d-none'),false);
      await $('compactModalForm').fire('submit');
      assert.equal(modal.shown,false);
      assert.equal(row(label).children[1].textContent,expected);
    }
    assert.equal(calls.length,0);
  });
}
