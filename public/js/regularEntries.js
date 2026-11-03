(() => {
  const data = JSON.parse(document.getElementById('regularEntryData').textContent);
  const form = document.getElementById('regularEntryForm');
  const modalElement = document.getElementById('regularEntryModal');
  const menu = document.getElementById('regularEntryMenu');
  const deleteForm = document.getElementById('regularEntryDelete');
  const editButton = document.getElementById('regularEntryEdit');
  const inputs = [...document.querySelectorAll('.regular-entry-amount')];
  const status = document.getElementById('regularAmountStatus');
  const saved = new Map(inputs.map(input => [input.dataset.entryId, input.value]));
  const queues = new Map();
  let activeRow;
  let modal;

  const saveAmount = input => {
    const id = input.dataset.entryId;
    const value = input.value;
    if (!input.checkValidity() || !Number.isFinite(Number(value))) {
      return Promise.reject(new Error('有効な金額を入力してください'));
    }
    const task = (queues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      if (saved.get(id) === value) return;
      status.textContent = '金額を保存中…';
      const response = await fetch(`/matomete/regular-entry/amount/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ amount: value })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || '金額を保存できませんでした');
      saved.set(id, value);
      const entry = data.entries.find(entry => String(entry._id) === id);
      if (entry) entry.amount = Number(value);
      status.textContent = '金額を保存しました。次回にも反映されます。';
      status.classList.remove('text-danger');
    });
    queues.set(id, task);
    return task;
  };
  const reportError = error => {
    if (status) {
      status.textContent = `${error.message}。金額を確認して再度保存してください。`;
      status.classList.add('text-danger');
    }
  };
  const flushAmounts = () => Promise.all(inputs.map(saveAmount));
  inputs.forEach(input => input.addEventListener('change', () => saveAmount(input).catch(reportError)));

  const toggleCategory = () => {
    const selected = form.elements.cf.value;
    for (const [cf, id] of Object.entries({ 支出: 'expense_group', 収入: 'income_group', 控除: 'deduction_group', 貯蓄: 'saving_group' })) {
      const group = document.getElementById(id);
      group.style.display = selected === cf ? '' : 'none';
      group.querySelector('select').required = selected === cf;
    }
  };
  form.elements.cf.addEventListener('change', toggleCategory);
  const hideMenu = (restoreFocus = false) => {
    menu.classList.remove('show');
    if (restoreFocus) activeRow?.focus();
  };
  const openEditor = entry => {
    hideMenu();
    form.reset();
    form.action = entry ? `/matomete/regular-entry/update/${encodeURIComponent(entry._id)}` : '/matomete/regular-entry/create';
    document.getElementById('regularEntryModalTitle').textContent = entry ? 'まとめて入力項目の編集' : 'まとめて入力の項目追加';
    form.querySelector('[type="submit"]').textContent = entry ? '編集内容を保存' : 'まとめて入力項目に追加';
    if (entry) {
      ['cf', 'income_item', 'expense_item', 'dedu_item', 'saving_item', 'content', 'amount', 'payment_type', 'day'].forEach(name => {
        const field = form.elements[name];
        const value = entry[name] ?? '';
        if (field.tagName === 'SELECT' && value && ![...field.options].some(option => option.value === String(value))) {
          field.add(new Option(value, value));
        }
        field.value = value;
      });
      const inline = inputs.find(input => input.dataset.entryId === String(entry._id));
      if (inline) form.elements.amount.value = inline.value;
    }
    toggleCategory();
    modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.show();
  };
  document.getElementById('regularEntryAdd').addEventListener('click', () => openEditor(null));
  editButton.addEventListener('click', () => openEditor(data.entries.find(entry => String(entry._id) === activeRow.dataset.regularId)));

  const showMenu = (row, x, y) => {
    activeRow = row;
    deleteForm.action = `/matomete/regular-entry/${encodeURIComponent(row.dataset.regularId)}?_method=DELETE`;
    menu.classList.add('show');
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    editButton.focus();
  };
  document.querySelectorAll('[data-regular-id]').forEach(row => {
    let timer, x, y, held = false;
    const cancel = () => clearTimeout(timer);
    const isControl = target => target.closest('input, button, select, textarea, a');
    row.addEventListener('contextmenu', event => {
      if (isControl(event.target)) return;
      event.preventDefault();
      cancel();
      showMenu(row, event.clientX, event.clientY);
    });
    row.addEventListener('pointerdown', event => {
      cancel();
      held = false;
      if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0 || isControl(event.target)) return;
      x = event.clientX; y = event.clientY;
      timer = setTimeout(() => { held = true; showMenu(row, x, y); }, 600);
    });
    row.addEventListener('pointermove', event => {
      if (Math.hypot(event.clientX - x, event.clientY - y) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => row.addEventListener(type, cancel));
    row.addEventListener('click', event => {
      if (held) { event.preventDefault(); event.stopPropagation(); held = false; }
    }, true);
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        showMenu(row, bounds.left + 16, bounds.top + 16);
      }
    });
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hideMenu(); });
  document.addEventListener('scroll', () => hideMenu(), true);
  window.addEventListener('resize', () => hideMenu());
  document.addEventListener('keydown', event => {
    if (!menu.classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); hideMenu(true); }
    if (event.key === 'Tab') hideMenu();
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('[role="menuitem"]')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + 1) % buttons.length].focus();
    }
  });

  // Finish saving inline amounts before executing, editing, or deleting an item.
  [document.getElementById('regularEntryExecuteForm'), form, deleteForm].filter(Boolean).forEach(target => {
    target.classList.add('no-js-submit');
    let submitting = false;
    target.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitting) return;
      if (target === deleteForm && !window.confirm('この項目を無効化します。後で復活できます。実行しますか？')) return;
      submitting = true;
      const button = event.submitter;
      if (button) button.disabled = true;
      try {
        await flushAmounts();
        if (target === form) {
          const response = await fetch(form.action, {
            method: 'POST', headers: { Accept: 'application/json' },
            body: new URLSearchParams(new FormData(form))
          });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.message || '保存できませんでした');
          window.location.href = '/matomete/regular-entry/push';
        } else {
          HTMLFormElement.prototype.submit.call(target);
        }
      } catch (error) {
        reportError(error);
        window.alert(error.message);
        submitting = false;
        if (button) button.disabled = false;
      }
    });
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (data.editId) openEditor(data.entries.find(entry => String(entry._id) === data.editId));
  });
})();
