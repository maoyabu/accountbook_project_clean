(() => {
  if (window.FinanceBusy) return;
  const tokens = new Map();
  let overlay, previousFocus, inertElements = [], navigationRelease, internalDownload = false;
  const restoreButtons = new Map();
  let parentBusy;
  try { if (window.parent !== window && window.parent.location.origin === location.origin) parentBusy = window.parent.FinanceBusy; } catch (_) {}
  const owner = parentBusy ? window.frameElement?.id || 'finance-iframe' : 'page';
  function closeOverlay() {
    if (!overlay) return;
    overlay.close(); overlay.remove(); overlay = null;
    inertElements.forEach(element => { element.inert = false; }); inertElements = [];
    document.body.removeAttribute('aria-busy');
    if (previousFocus?.isConnected) previousFocus.focus();
    restoreFormButtons();
  }
  function restoreFormButtons() {
    for (const [button, state] of restoreButtons) if (button.isConnected) {
      button.disabled = state.disabled;
      if (/^送信中[.…]+$/.test(button.textContent)) button.textContent = state.text;
    }
    restoreButtons.clear();
  }
  function begin(message = '更新中です', scope = owner) {
    if (parentBusy) return parentBusy.begin(message, scope);
    const token = {};
    tokens.set(token, scope);
    if (!overlay && document.body) {
      previousFocus = document.activeElement;
      overlay = document.createElement('dialog'); overlay.className = 'finance-operation-busy';
      overlay.setAttribute('aria-label', message);
      overlay.innerHTML = '<div role="status" aria-live="polite"><span class="finance-operation-spinner" aria-hidden="true"></span><strong></strong><p>完了するまでお待ちください。</p></div>';
      overlay.querySelector('strong').textContent = message;
      document.body.append(overlay);
      inertElements = [...document.body.children].filter(element => element !== overlay && !element.inert);
      inertElements.forEach(element => { element.inert = true; });
      document.body.setAttribute('aria-busy', 'true');
      overlay.addEventListener('cancel', event => event.preventDefault()); overlay.showModal();
    }
    let released = false;
    return () => { if (released) return; released = true; tokens.delete(token); if (!tokens.size) closeOverlay(); };
  }
  function clearOwner(scope = owner) {
    if (parentBusy) { parentBusy.clearOwner(scope); return; }
    for (const [token, tokenOwner] of tokens) if (tokenOwner === scope) tokens.delete(token);
    if (!tokens.size) closeOverlay();
  }
  function navigate(message = 'ページを読み込み中です') {
    if (!navigationRelease) navigationRelease = begin(message, owner + ':navigation');
  }
  const api = window.FinanceBusy = {
    get active() { return parentBusy ? parentBusy.active : tokens.size > 0; },
    begin, clearOwner, navigate,
    async run(task, message) { const end = begin(message); try { return await task(); } finally { end(); } }
  };
  for (const type of ['click','dblclick','keydown','keyup','input','change','pointerdown','touchstart','dragstart','drop','submit']) {
    window.addEventListener(type, event => {
      if (!api.active || (internalDownload && type === 'click')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }
  const selfTarget = target => !target || ['_self','_top','_parent'].includes(target.toLowerCase());
  const pageUrl = value => { try { return /^https?:$/.test(new URL(value, location.href).protocol); } catch (_) { return false; } };
  const isDownload = value => {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return false;
    return url.pathname.replace(/\/$/,'') === '/export' || /-exls$/.test(url.pathname)
      || /\.(?:xlsx?|csv|pdf|zip)$/i.test(url.pathname)
      || !url.pathname.startsWith('/export/') && /\/(?:download|export)(?:\/|$)/i.test(url.pathname);
  };
  const nativeFetch = window.fetch.bind(window);
  // Wait for the response body too; response headers alone do not complete a save/download.
  window.fetch = async (input, options) => {
    const method = String(options?.method || input?.method || 'GET').toUpperCase();
    const end = begin(['GET','HEAD'].includes(method) ? '読み込み中です' : '更新中です');
    try {
      const response = await nativeFetch(input, options);
      if (response.body) await response.clone().arrayBuffer();
      return response;
    } finally { setTimeout(end, 0); }
  };
  async function download(url, options, fallbackName) {
    const end = begin('ファイルを作成・ダウンロード中です');
    try {
      const response = await nativeFetch(url, options);
      if (!response.ok) throw new Error('ダウンロードできませんでした。再度お試しください。');
      const disposition = response.headers.get('content-disposition') || '';
      if (!disposition && /text\/html/i.test(response.headers.get('content-type') || '')) {
        navigate(); location.assign(response.url || url); return;
      }
      const utfName = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const plainName = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
      let name = fallbackName || '家計簿.xlsx';
      if (utfName) { try { name = decodeURIComponent(utfName[1]); } catch (_) {} }
      else if (plainName) name = plainName[1] || plainName[2];
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = blobUrl; link.download = name;
      document.body.append(link); internalDownload = true;
      try { link.click(); } finally { internalDownload = false; link.remove(); }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (error) { window.alert(error.message); }
    finally { end(); }
  }
  window.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || !selfTarget(link.target) || !pageUrl(link.href) || link.getAttribute('href')?.startsWith('#')) return;
    const url = new URL(link.href, location.href), current = new URL(location.href);
    if (link.hasAttribute('download') && url.protocol === 'blob:') return;
    if (url.hash && url.origin === current.origin && url.pathname === current.pathname && url.search === current.search) return;
    if (isDownload(url.href) || link.hasAttribute('download') && url.origin === current.origin) {
      event.preventDefault(); void download(url.href, undefined, link.download); return;
    }
    if (!link.hasAttribute('download')) navigate();
  });
  function formInfo(form, button) {
    return {
      method: (button?.getAttribute('formmethod') || form.method || 'get').toLowerCase(),
      target: button?.getAttribute('formtarget') ?? form.target,
      action: button?.getAttribute('formaction') || form.action || location.href
    };
  }
  function submitDownload(form, button, info) {
    const data = new FormData(form);
    if (button?.name) data.append(button.name, button.value);
    const url = new URL(info.action, location.href);
    const options = { method: info.method.toUpperCase() };
    if (info.method === 'get') { url.search = new URLSearchParams(data).toString(); }
    else options.body = data;
    void download(url.href, options);
  }
  window.addEventListener('submit', event => {
    const form = event.target;
    for (const button of form.querySelectorAll('button,input[type="submit"]')) if (!restoreButtons.has(button)) restoreButtons.set(button, { disabled: button.disabled, text: button.textContent });
  }, { capture: true });
  window.addEventListener('submit', event => {
    const form = event.target, info = formInfo(form, event.submitter);
    if (event.defaultPrevented || info.method === 'dialog' || !selfTarget(info.target) || !pageUrl(info.action)) return;
    if (isDownload(info.action)) { event.preventDefault(); submitDownload(form, event.submitter, info); return; }
    navigate(form.dataset.busyMessage || (info.method === 'get' ? 'ページを読み込み中です' : '送信・更新中です'));
  });
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    const info = formInfo(this);
    if (info.method === 'dialog' || !selfTarget(info.target) || !pageUrl(info.action)) return nativeSubmit.call(this);
    if (navigationRelease) return;
    if (isDownload(info.action)) { submitDownload(this, undefined, info); return; }
    navigate(this.dataset.busyMessage || (info.method === 'get' ? 'ページを読み込み中です' : '送信・更新中です'));
    try { return nativeSubmit.call(this); } catch (error) { navigationRelease?.(); navigationRelease = null; throw error; }
  };
  window.addEventListener('beforeunload', () => navigate());
  window.addEventListener('pageshow', event => {
    clearOwner(owner + ':navigation');
    if (event.persisted) clearOwner();
    navigationRelease = null; restoreFormButtons();
  });
})();
