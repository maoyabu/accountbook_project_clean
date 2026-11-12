(() => {
  const config = JSON.parse(document.getElementById('compactData').textContent);
  let values = { ...config.values }, options = config.options;
  const steps = ['date', 'cf', 'category', 'sub_tag', 'content', 'amount', 'payment_type']
    .filter(field => field !== 'sub_tag' || config.tagEnabled);
  const labels = { date: '年月日', cf: '収支区分', category: '詳細区分', sub_tag: 'タグ', content: '内容', amount: '金額', payment_type: '支払種別', groupId: 'グループ', userId: '使用者' };
  const $ = id => document.getElementById(id);
  const listMode = config.mode === 'new' && config.entryMode === 'list';
  let index = 0, reviewing = config.mode === 'edit' || config.reviewing === true || listMode, busy = false, copy = false, editingField;
  let modal, voice;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  function errorFor(field, candidate = values) {
    if (field === 'date' && !validDate(candidate.date)) return '有効な年月日を入力してください';
    if (field === 'cf' && !['支出', '収入', '控除', '貯蓄'].includes(candidate.cf)) return '収支区分を選んでください';
    if (field === 'category' && !(options.categories[candidate.cf] || []).includes(candidate.category)) return '詳細区分を選んでください';
    if (field === 'content' && !String(candidate.content || '').trim()) return '内容を入力してください';
    if (field === 'amount' && (String(candidate.amount).trim() === '' || !Number.isFinite(Number(candidate.amount)))) return '金額を数字で入力してください';
    if (field === 'payment_type' && !options.payments.includes(candidate.payment_type)) return '使用者の支払種別を選んでください';
    return '';
  }
  function labelValue(field) {
    if (field === 'groupId') return options.groups.find(group => group.id === values.groupId)?.name || '未選択';
    if (field === 'userId') return options.users.find(user => user.id === values.userId)?.name || '未選択';
    if (listMode && !String(values[field] ?? '').trim()) return '';
    if (field === 'amount') return String(values.amount).trim() !== '' ? `¥${Number(values.amount).toLocaleString('ja-JP')}` : '未入力';
    if (field === 'sub_tag') return values.sub_tag || 'なし';
    return values[field] || '未入力';
  }
  function tags() {
    const matched = (options.commonTags || []).filter(group => !group.category || group.category === values.category);
    return [...new Set(matched.flatMap(group => (group.tags || []).map(tag => tag.name)).filter(Boolean))];
  }
  function choiceTags(host, list, input) {
    const chips = document.createElement('div'); chips.className = 'compact-choices';
    chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', input.getAttribute('aria-label'));
    const buttons = [];
    function sync() {
      buttons.forEach(({ button, value }) => {
        const selected = input.value === value;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }
    list.forEach(item => {
      const value = typeof item === 'string' ? item : item.id;
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = typeof item === 'string' ? item : item.name;
      button.addEventListener('click', () => {
        if (busy) return;
        input.value = value; sync();
        return input.onChoice?.(value);
      });
      buttons.push({ button, value }); chips.append(button);
    });
    input.addEventListener('input', sync);
    sync(); host.append(chips);
  }
  function createField(field, host, onChange) {
    host.replaceChildren();
    const isChoice = ['cf', 'category', 'payment_type', 'groupId', 'userId'].includes(field);
    const input = document.createElement('input');
    input.id = host.id + 'Input'; input.className = 'form-control'; input.setAttribute('aria-label', labels[field]);
    input.type = isChoice ? 'hidden' : field === 'date' ? 'date' : field === 'amount' ? 'number' : 'text';
    if (field === 'amount') { input.inputMode = 'numeric'; input.setAttribute('data-money-input', ''); input.step = 'any'; }
    if (field === 'content') input.maxLength = 2000;
    if (field === 'sub_tag') { input.maxLength = 100; input.disabled = !config.tagEnabled; }
    input.value = values[field] ?? '';
    if (field !== 'sub_tag' && !isChoice) input.required = true;
    if (onChange) { input.onChoice = onChange; input.addEventListener('change', () => onChange(input.value)); }
    host.append(input);
    if (isChoice) {
      const list = field === 'cf' ? ['支出', '収入', '控除', '貯蓄'] : field === 'category' ? options.categories[values.cf] || [] : field === 'payment_type' ? options.payments : field === 'groupId' ? options.groups : options.users;
      choiceTags(host, list, input);
      if (!list.length) {
        const hint = document.createElement('p'); hint.className = 'compact-hint';
        hint.textContent = field === 'payment_type' ? 'この使用者の支払種別がありません。家計簿設定の「支払い方法の設定」で登録してください。' : '選択肢がありません。関連する項目や設定を確認してください。'; host.append(hint);
      }
    }
    if (field === 'date' && config.conversation) {
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
      choiceTags(host, Array.from({ length: 7 }, (_, daysAgo) => {
        const day = new Date(today); day.setUTCDate(day.getUTCDate() - daysAgo);
        const id = day.toISOString().slice(0, 10);
        return { id, name: daysAgo === 0 ? '今日' : daysAgo === 1 ? '昨日' : `${day.getUTCMonth() + 1}月${day.getUTCDate()}日` };
      }), input);
    }
    if (field === 'sub_tag') {
      const hint = document.createElement('p'); hint.className = 'compact-hint';
      hint.textContent = tags().length ? '候補のタグを選択できます。新しいタグも入力できます。不要ならSKIP。' : 'タグ候補はありません。不要ならSKIPで進めます。'; host.append(hint);
      if (config.tagEnabled) choiceTags(host, tags(), input);
    }
    return input;
  }
  function render() {
    $('compactIdentity').replaceChildren();
    ['groupId', 'userId'].forEach(field => {
      const element = document.createElement(config.mode === 'edit' ? 'button' : 'div');
      if (config.mode === 'edit') { element.type = 'button'; element.addEventListener('click', () => openModal(field)); }
      element.textContent = `${labels[field]}　${labelValue(field)}`; $('compactIdentity').append(element);
    });
    $('compactRows').replaceChildren();
    const visible = (reviewing ? steps : steps.slice(0, index))
      .filter(field => field !== 'category' || values.cf);
    visible.forEach(field => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'compact-row' + (!listMode && errorFor(field) ? ' is-invalid' : '');
      row.setAttribute('aria-label', `${labels[field]}：${labelValue(field)}。タップして修正`);
      for (const [cls, text] of [['compact-row-label', labels[field]], ['compact-row-value', labelValue(field)], ['compact-row-edit', '›']]) {
        const span = document.createElement('span'); span.className = cls; span.textContent = text; row.append(span);
      }
      row.addEventListener('click', () => openModal(field)); $('compactRows').append(row);
    });
    $('compactStepPanel').classList.toggle('d-none', reviewing || listMode);
    $('compactConfirm').classList.toggle('d-none', !reviewing);
    $('compactProgress').textContent = reviewing ? (listMode ? '入力項目を選択してください' : '入力内容の確認') : `STEP ${index + 1} / ${steps.length}`;
    if (reviewing) voice?.stop();
    if (!reviewing && !listMode) {
      const field = steps[index]; $('compactStepTitle').textContent = labels[field];
      $('compactStepHint').textContent = config.continuing && ['date', 'cf', 'category'].includes(field) ? '直前の入力内容です。確認・変更して「次へ」。' : '';
      const input = createField(field, $('compactStepField'));
      input.onChoice = async value => {
        if (reviewing || steps[index] !== field) return;
        try { await completeStep(value); }
        catch (err) { $('compactStepError').textContent = err.message; }
      };
      $('compactStepError').textContent = '';
      $('compactBack').disabled = index === 0; $('compactSkip').classList.toggle('d-none', field !== 'sub_tag');
      $('compactNext').textContent = index === steps.length - 1 ? '確認へ' : '次へ';
      voice?.prompt(`${labels[field]}を${['cf', 'category', 'payment_type'].includes(field) ? '選んで' : '入力して'}ください。`, ['content', 'amount'].includes(field));
    }
  }
  async function apply(field, value) {
    const candidate = { ...values, [field]: value };
    const fieldError = ['date', 'cf', 'content', 'amount', 'category', 'payment_type'].includes(field) ? errorFor(field, candidate) : '';
    if (fieldError) throw new Error(fieldError);
    if (['date', 'groupId', 'userId'].includes(field)) {
      const response = await fetch(`/finance/entry-step/options?${new URLSearchParams({ date: candidate.date, groupId: candidate.groupId, userId: candidate.userId })}`, { headers: { Accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || '候補を取得できませんでした');
      options = result.options; candidate.userId = options.userId;
      if (!(options.categories[candidate.cf] || []).includes(candidate.category)) candidate.category = '';
      if (field !== 'date' || !options.payments.includes(candidate.payment_type)) candidate.payment_type = '';
      if (field === 'groupId') candidate.sub_tag = '';
    }
    if (field === 'cf' && value !== values.cf) { candidate.category = ''; candidate.sub_tag = ''; }
    if (field === 'category' && value !== values.category) candidate.sub_tag = '';
    values = candidate;
  }
  function openModal(field) {
    if (busy) return;
    voice?.stop();
    editingField = field; $('compactModalTitle').textContent = labels[field]; $('compactModalError').textContent = '';
    createField(field, $('compactModalField'));
    modal = bootstrap.Modal.getOrCreateInstance($('compactFieldModal')); modal.show();
  }
  $('compactFieldModal').addEventListener('shown.bs.modal', () => { const field = $('compactModalField'); const target = field.querySelector('button[aria-pressed="true"]') || field.querySelector('button, input:not([type="hidden"])'); target?.focus(); });
  $('compactModalForm').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; $('compactModalApply').disabled = true;
    try {
      await apply(editingField, $('compactModalField').querySelector('input,select').value);
      if (!reviewing) { const invalid = steps.slice(0, index).findIndex(field => errorFor(field)); if (invalid >= 0) index = invalid; }
      render(); modal.hide();
    } catch (err) { $('compactModalError').textContent = err.message; }
    finally { busy = false; $('compactModalApply').disabled = false; }
  });
  async function completeStep(value) {
    if (busy || reviewing) return;
    busy = true; $('compactNext').disabled = true; voice?.stop();
    try { await apply(steps[index], value); index++; if (index === steps.length) reviewing = true; render(); }
    finally { busy = false; $('compactNext').disabled = false; }
  }
  $('compactStepForm').addEventListener('submit', async event => {
    event.preventDefault();
    try { await completeStep($('compactStepField').querySelector('input,select').value); }
    catch (err) { $('compactStepError').textContent = err.message; }
  });
  $('compactSkip').addEventListener('click', () => { if (busy) return; values.sub_tag = ''; index++; render(); });
  $('compactBack').addEventListener('click', () => { if (busy || !index) return; index--; render(); });
  $('compactCopy')?.addEventListener('click', () => {
    if (busy) return; copy = true; $('compactTitle').textContent = '複製して編集'; $('compactCopy').disabled = true; $('compactSave').textContent = '複製を保存';
  });
  async function save(continuing) {
    if (busy) return;
    const invalid = steps.find(field => errorFor(field));
    if (invalid) { showError(errorFor(invalid)); openModal(invalid); return; }
    busy = true; $('compactSave').disabled = true; $('compactContinue').disabled = true; $('compactError').classList.add('d-none');
    try {
      const endpoint = config.mode === 'edit' ? `/finance/${encodeURIComponent(config.id)}/compact` : '/finance/entry-step';
      let confirmed = false, result;
      for (;;) {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ values, copy, confirmDuplicate: confirmed }) });
        result = await response.json();
        if (response.status === 409 && result.duplicate && !confirmed) { if (!window.confirm(result.message)) return; confirmed = true; continue; }
        if (!response.ok || !result.ok) throw new Error(result.message || Object.values(result.errors || {}).join('、') || '保存できませんでした');
        break;
      }
      if (continuing) {
        const next = new URL(result.continueUrl, window.location.origin);
        if (config.conversation || config.continueConversation) next.pathname = '/finance/entry-conversation';
        if (config.embedded) { next.searchParams.set('modal', '1'); next.searchParams.set('returnTo', config.returnTo); }
        window.location.href = next.href;
      } else if (config.embedded && window.parent !== window) {
        window.parent.postMessage({ type: 'finance-edit-saved' }, window.location.origin);
      } else window.location.href = config.returnTo;
    } catch (err) { showError(err.message); }
    finally { busy = false; $('compactSave').disabled = false; $('compactContinue').disabled = false; }
  }
  function showError(message) { $('compactError').textContent = message; $('compactError').classList.remove('d-none'); }
  $('compactSave').addEventListener('click', () => save(false)); $('compactContinue').addEventListener('click', () => save(true));
  if (config.conversation) {
    voice = window.createFinanceConversation({ button: $('compactMic'), status: $('compactVoiceStatus'), onAnswer: async raw => {
      if (busy || reviewing) return;
      const field = steps[index];
      if (field === 'sub_tag' && ['スキップ', 'なし', '不要'].includes(raw.trim())) { values.sub_tag = ''; index++; render(); return; }
      await completeStep(window.parseFinanceVoiceAnswer(field, raw, values, options));
    } });
    window.addEventListener('pagehide', () => voice.stop());
  }
  render();
})();
