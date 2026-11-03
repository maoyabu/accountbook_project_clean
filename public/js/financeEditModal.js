(() => {
  const element = document.getElementById('financeEditModal');
  const frame = document.getElementById('financeEditFrame');
  let modal;
  window.openFinanceEditModal = (editUrl) => {
    const url = new URL(editUrl, window.location.origin);
    if (url.origin !== window.location.origin) return;
    url.searchParams.set('modal', '1');
    url.searchParams.set('returnTo', window.location.pathname + window.location.search);
    frame.src = url.href;
    modal = bootstrap.Modal.getOrCreateInstance(element);
    modal.show();
  };
  document.querySelectorAll('form[data-finance-edit]').forEach(form => {
    form.addEventListener('submit', event => {
      event.preventDefault();
      window.openFinanceEditModal(form.action);
    });
  });
  const menu = document.getElementById('financeRowMenu');
  const editButton = document.getElementById('financeRowEdit');
  const deleteForm = document.getElementById('financeRowDeleteForm');
  let activeRow;
  const hideMenu = (restoreFocus = false) => {
    menu.classList.remove('show');
    if (restoreFocus) activeRow?.focus();
  };
  const showMenu = (row, x, y) => {
    activeRow = row;
    const editUrl = new URL(row.dataset.financeEditUrl, window.location.origin);
    deleteForm.action = editUrl.pathname.replace(/\/edit$/, '') + '?_method=DELETE';
    menu.classList.add('show');
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    editButton.focus();
  };
  editButton.addEventListener('click', () => {
    hideMenu();
    window.openFinanceEditModal(activeRow.dataset.financeEditUrl);
  });
  deleteForm.addEventListener('submit', event => {
    if (!window.confirm('本当に削除しますか？')) event.preventDefault();
    hideMenu(true);
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) hideMenu();
  });
  document.addEventListener('keydown', event => {
    if (!menu.classList.contains('show')) return;
    if (event.key === 'Escape') { event.preventDefault(); hideMenu(true); }
    if (event.key === 'Tab') hideMenu();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  window.addEventListener('resize', () => hideMenu());
  document.addEventListener('scroll', () => hideMenu(), true);
  document.querySelectorAll('[data-finance-edit-url]').forEach(row => {
    let timer;
    let startX;
    let startY;
    let held = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    const isControl = target => target.closest('button, a, input, select, textarea, form');
    row.addEventListener('pointerdown', event => {
      cancel();
      held = false;
      if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0 || isControl(event.target)) return;
      startX = event.clientX;
      startY = event.clientY;
      timer = setTimeout(() => {
        cancel();
        held = true;
        showMenu(row, startX, startY);
      }, 600);
    });
    row.addEventListener('pointermove', event => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => row.addEventListener(type, cancel));
    row.addEventListener('click', event => {
      if (held) { event.preventDefault(); event.stopPropagation(); held = false; }
    }, true);
    row.addEventListener('contextmenu', event => {
      if (isControl(event.target)) return;
      event.preventDefault();
      cancel();
      showMenu(row, event.clientX, event.clientY);
    });
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        showMenu(row, bounds.left + 16, bounds.top + 16);
      }
    });
  });
  element.addEventListener('hidden.bs.modal' , () => frame.removeAttribute('src'));
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'finance-edit-saved') return;
    modal?.hide();
    window.location.reload();
  });
})();
