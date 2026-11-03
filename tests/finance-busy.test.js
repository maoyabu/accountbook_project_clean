const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/financeBusy.js'), 'utf8');
class Element {
  constructor(tag) { this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.inert=false;this.isConnected=true;this.disabled=false;this.textContent='';this.listeners={}; }
  setAttribute(key,value){this.attributes[key]=value;}
  getAttribute(key){return this.attributes[key]??null;}
  hasAttribute(key){return Object.hasOwn(this.attributes,key);}
  removeAttribute(key){delete this.attributes[key];}
  append(child){this.children.push(child);child.parent=this;}
  remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}
  querySelector(){return this.strong ||= new Element('strong');}
  querySelectorAll(){return this.buttons||[];}
  addEventListener(type,fn){this.listeners[type]=fn;}
  closest(selector){return selector==='a[href]'&&this.tag==='a'?this:null;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  focus(){}
}
function setup(fetcher = async()=>new Response('{"ok":true}',{headers:{'content-type':'application/json'}}), parent) {
  const handlers={},calls=[],downloads=[],alerts=[];
  const body=new Element('body'),main=new Element('main'),preInert=new Element('aside');preInert.inert=true;body.append(main);body.append(preInert);
  const location={href:'https://finance.test/finance/top',origin:'https://finance.test',assign(url){this.assigned=url;emit('beforeunload');}};
  class Form extends Element { constructor(){super('form');this.method='post';this.action='/finance/save';this.fields=[['amount','1000']];} submit(){this.submitted=(this.submitted||0)+1;} }
  class TestURL extends URL {static createObjectURL(){return 'blob:test';}static revokeObjectURL(){}}
  const window={location,frameElement:parent?{id:'financeEditFrame'}:null,fetch:async(...args)=>{calls.push(args);return fetcher(...args);},alert:value=>alerts.push(value),addEventListener(type,fn,options){(handlers[type] ||= []).push({fn,capture:typeof options==='boolean'?options:options?.capture});}};
  window.parent=parent||window;
  function emit(type,overrides={},middle) {
    const event={button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...overrides};
    for(const entry of (handlers[type]||[]).filter(entry=>entry.capture)){entry.fn(event);if(event.stopped)return event;}
    middle?.(event);
    for(const entry of (handlers[type]||[]).filter(entry=>!entry.capture)){entry.fn(event);if(event.stopped)break;}
    return event;
  }
  const document={body,activeElement:main,createElement:tag=>{const element=new Element(tag);if(tag==='a')element.click=()=>{downloads.push(element.download);emit('click',{target:element});};return element;}};
  class TestFormData extends URLSearchParams {constructor(form){super(form.fields);}}
  vm.runInNewContext(source,{window,document,location,URL:TestURL,HTMLFormElement:Form,FormData:TestFormData,URLSearchParams,setTimeout:(fn,ms)=>{if(!ms)setImmediate(fn);}});
  const link=(href,attrs={})=>{const element=new Element('a');element.href=new URL(href,location.href).href;element.attributes={href,...attrs};return element;};
  return {window,api:window.FinanceBusy,body,main,preInert,Form,emit,link,calls,downloads,alerts,location};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('busy overlay blocks mouse, touch, keyboard and duplicate submissions and restores inert state',()=>{
  const f=setup();const end=f.api.begin('更新中です');assert.equal(f.api.active,true);assert.equal(f.main.inert,true);
  assert.equal(f.body.children.at(-1).strong.textContent,'更新中です');
  for(const type of ['click','touchstart','keydown','change','submit'])assert.equal(f.emit(type).stopped,true);
  end();end();assert.equal(f.api.active,false);assert.equal(f.main.inert,false);assert.equal(f.preInert.inert,true);
});
test('parallel amount saves remain locked until all response bodies complete and retain JSON responses',async()=>{
  let first,second;
  const f=setup(()=>new Promise(resolve=>{if(!first)first=resolve;else second=resolve;}));
  const a=f.window.fetch('/amount/1',{method:'POST'}),b=f.window.fetch('/amount/2',{method:'POST'});
  first(new Response('{"ok":true}'));const result=await a;assert.deepEqual(await result.json(),{ok:true});await tick();assert.equal(f.api.active,true);
  second(new Response('done'));await b;await tick();assert.equal(f.api.active,false);
});
test('headers alone do not unlock an in-progress response body',async()=>{
  let controller;
  const f=setup(async()=>new Response(new ReadableStream({start(value){controller=value;}})));
  const pending=f.window.fetch('/save',{method:'POST'});await tick();assert.equal(f.api.active,true);
  controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();await pending;await tick();assert.equal(f.api.active,false);
});
test('failed requests recover controls and a navigation started after fetch keeps its lock',async()=>{
  const failed=setup(async()=>{throw new Error('network');});await assert.rejects(failed.window.fetch('/save'),/network/);await tick();assert.equal(failed.api.active,false);
  const f=setup();await f.window.fetch('/save',{method:'POST'});f.emit('beforeunload');await tick();assert.equal(f.api.active,true);
  f.emit('pageshow',{persisted:true});assert.equal(f.api.active,false);
});
test('cancelled submissions, anchors, new tabs and modal links never lock the page',()=>{
  const f=setup();const form=new f.Form();f.emit('submit',{target:form,defaultPrevented:true});assert.equal(f.api.active,false);
  for(const link of [f.link('#section'),f.link('/finance/top#section'),Object.assign(f.link('/finance/list'),{target:'_blank'})])f.emit('click',{target:link});
  f.emit('click',{target:f.link('/finance/edit'),defaultPrevented:true});assert.equal(f.api.active,false);
  f.emit('click',{target:f.link('/finance/list')});assert.equal(f.api.active,true);
});
test('native form.submit handles filters and blocks duplicate submissions; back navigation restores submit buttons',()=>{
  const f=setup();const form=new f.Form();form.method='get';form.action='/finance/list';form.submit();form.submit();assert.equal(form.submitted,1);
  f.emit('pageshow',{persisted:true});
  const button=new Element('button');button.textContent='保存';form.buttons=[button];
  f.emit('submit',{target:form},()=>{button.disabled=true;button.textContent='送信中...';});assert.equal(f.api.active,true);
  f.emit('pageshow',{persisted:true});assert.equal(button.disabled,false);assert.equal(button.textContent,'保存');
});
test('Excel download waits for completion, uses attachment filename, then unlocks without navigating',async()=>{
  const f=setup(async()=>new Response('excel bytes',{headers:{'content-disposition':"attachment; filename*=UTF-8''%E9%9B%86%E8%A8%88.xlsx",'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}}));
  f.emit('click',{target:f.link('/export/dashboard/yearly-m-exls')});assert.equal(f.api.active,true);
  for(let i=0;i<4;i++)await tick();assert.deepEqual(f.downloads,['集計.xlsx']);assert.equal(f.api.active,false);assert.equal(f.location.assigned,undefined);
});
test('export forms include the submitter and restore disabled sending buttons after download',async()=>{
  const f=setup(async()=>new Response('excel'));const form=new f.Form();form.method='get';form.action='/export/';const button=new Element('button');button.textContent='出力';button.name='format';button.value='excel';form.buttons=[button];
  f.emit('submit',{target:form,submitter:button},()=>{button.disabled=true;button.textContent='送信中...';});
  for(let i=0;i<4;i++)await tick();assert.match(f.calls[0][0],/amount=1000&format=excel/);assert.equal(f.api.active,false);assert.equal(button.disabled,false);assert.equal(button.textContent,'出力');
});
test('iframe operations lock the parent; arriving iframe clears old navigation but keeps new requests locked',()=>{
  const parent=setup(),child=setup(undefined,parent.window);
  child.emit('beforeunload');assert.equal(parent.api.active,true);
  const end=child.api.begin();child.emit('pageshow',{persisted:false});assert.equal(parent.api.active,true);
  end();assert.equal(parent.api.active,false);
});
