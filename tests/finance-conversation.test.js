const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('public/js/financeConversation.js','utf8');
function setup() {
  const sessions = [], answers = [];
  class Recognition {
    constructor(){this.handlers={};sessions.push(this);}
    addEventListener(event,fn){this.handlers[event]=fn;}
    start(){}
    abort(){}
    async fire(event,data){await this.handlers[event]?.(data);}
  }
  const window={SpeechRecognition:Recognition};
  vm.runInNewContext(source,{window,Intl,Date});
  const button={classList:{add(){},remove(){}},addEventListener(event,fn){this[event]=fn;}};
  const status={};
  const controller=window.createFinanceConversation({button,status,onAnswer:async answer=>answers.push(answer)});
  return {window,button,status,controller,sessions,answers};
}
test('spoken amounts preserve decimals, normalize full width digits and reject malformed amounts',()=>{
  const {window}=setup(); const parse=window.parseFinanceVoiceAnswer;
  assert.equal(parse('amount','１，２００円',{},{}),'1200');
  assert.equal(parse('amount','1,200.50円',{},{}),'1200.50');
  assert.throws(()=>parse('amount','100円と200円',{},{}));
});
test('voice selections use current category and owners payment options',()=>{
  const {window}=setup();const parse=window.parseFinanceVoiceAnswer;
  const options={categories:{支出:['食費']},payments:['本人カード']};
  assert.equal(parse('category','食費',{cf:'支出'},options),'食費');
  assert.throws(()=>parse('payment_type','家族カード',{},options));
  assert.equal(parse('date','2026年11月3日',{},options),'2026-11-03');
});
test('stale recognition after step change cannot submit another answer',async()=>{
  const {button,controller,sessions,answers}=setup();
  button.click();const old=sessions[0];controller.stop();button.click();const current=sessions[1];
  await old.fire('result',{results:[[{transcript:'古い回答'}]]});await old.fire('end');assert.equal(answers.length,0);
  await current.fire('result',{results:[[{transcript:'昼食'}]]});await current.fire('end');assert.deepEqual(answers,['昼食']);
});
