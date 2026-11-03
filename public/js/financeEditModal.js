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
  document.querySelectorAll('[data-finance-edit-url]').forEach(row => {
    let timer;
    let startX;
    let startY;
    const cancel = () => { clearTimeout(timer); timer = null; };
    row.addEventListener('pointerdown', event => {
      cancel();
      if (!event.isPrimary || event.button !== 0 || event.target.closest('button, a, input, select, textarea, form')) return;
      startX = event.clientX;
      startY = event.clientY;
      timer = setTimeout(() => {
        cancel();
        window.openFinanceEditModal(row.dataset.financeEditUrl);
      }, 600);
    });
    row.addEventListener('pointermove', event => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => row.addEventListener(type, cancel));
    row.addEventListener('contextmenu', event => {
      if (!event.target.closest('button, a, form')) event.preventDefault();
    });
    row.addEventListener('keydown', event => {
      if (event.target === row && event.key === 'Enter') {
        event.preventDefault();
        window.openFinanceEditModal(row.dataset.financeEditUrl);
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
