
  document.addEventListener("DOMContentLoaded", function () {
    const cfSelect = document.getElementById("asset_cf");
    const currentAssetGroup = document.getElementById("current_asset_group");
    const fixedAssetGroup = document.getElementById("fixed_asset_group");
    const intangibleAssetGroup = document.getElementById("intangible_asset_group");
    const debtGroup = document.getElementById("debt_group");
    const assetModal = new bootstrap.Modal(document.getElementById('assetModal'));
    const modalTitle = document.getElementById('assetModalLabel');
    const assetForm = document.getElementById('assetForm');
    const newAssetBtn = document.getElementById('newAssetBtn');
    const newAssetInline = document.getElementById('newAssetInline');
    const unlockBtn = document.getElementById("unlockSecureNoteBtn");
    const authSection = document.getElementById("secureNoteAuthSection");
    const verifyBtn = document.getElementById("verifySecureNoteBtn");
    const passwordInput = document.getElementById("secureNotePassword");
    const secureNoteField = document.getElementById("secure_note");
    const assetIdField = document.getElementById("assetIdField");
    let editingAssetId = null;

    const selects = currentAssetGroup.querySelectorAll('select, input');
    const fixedSelects = fixedAssetGroup.querySelectorAll('select, input');
    const intangibleSelects = intangibleAssetGroup.querySelectorAll('select, input');
    const debtSelects = debtGroup.querySelectorAll('select, input');

    function toggleCategory() {
      currentAssetGroup.style.display = "none";
      fixedAssetGroup.style.display = "none";
      intangibleAssetGroup.style.display = "none";
      debtGroup.style.display = "none";
      selects.forEach(s => s.disabled = true);
      fixedSelects.forEach(s => s.disabled = true);
      intangibleSelects.forEach(s => s.disabled = true);
      debtSelects.forEach(s => s.disabled = true);

      if (cfSelect.value === "金融資産") {
        currentAssetGroup.style.display = "block";
        selects.forEach(s => s.disabled = false);
      } else if (cfSelect.value === "実物資産") {
        fixedAssetGroup.style.display = "block";
        fixedSelects.forEach(s => s.disabled = false);
      } else if (cfSelect.value === "無形資産") {
        intangibleAssetGroup.style.display = "block";
        intangibleSelects.forEach(s => s.disabled = false);
      } else if (cfSelect.value === "負債") {
        debtGroup.style.display = "block";
        debtSelects.forEach(s => s.disabled = false);
      }
    }

    function fillForm(asset) {
      assetForm.reset();
      document.getElementById('assetFormError').classList.add('d-none');
      authSection.style.display = "none";
      passwordInput.value = '';
      secureNoteField.value = '';
      secureNoteField.setAttribute("disabled", "disabled");
      unlockBtn.style.display = "inline-block";
      editingAssetId = asset?.id || null;

      if (!asset) {
        modalTitle.textContent = "資産を登録";
        assetForm.action = "/asset/create";
        cfSelect.value = cfSelect.options[0]?.value || '';
        toggleCategory();
        // 新規はセキュア情報なし
        unlockBtn.style.display = "none";
        return;
      }

      modalTitle.textContent = "資産を編集";
      assetForm.action = `/asset/update/${asset.id}`;
      assetIdField.value = asset.id;
      document.getElementById('code').value = asset.code || '';
      document.getElementById('content').value = asset.content || '';
      document.getElementById('amount').value = asset.amount || 0;
      document.getElementById('monetary_unit').value = asset.monetary_unit || '';
      cfSelect.value = asset.asset_cf || '';

      toggleCategory();
      if (asset.asset_cf === "金融資産") {
        document.getElementById('asset_item_current').value = asset.asset_item || '';
      } else if (asset.asset_cf === "実物資産") {
        document.getElementById('asset_item_fixed').value = asset.asset_item || '';
      } else if (asset.asset_cf === "無形資産") {
        document.getElementById('asset_item_intangible').value = asset.asset_item || '';
      } else if (asset.asset_cf === "負債") {
        document.getElementById('asset_item_debt').value = asset.asset_item || '';
      }

      secureNoteField.value = "🔒 セキュア情報はパスワード認証で取得";
    }

    cfSelect.addEventListener("change", toggleCategory);
    toggleCategory();

    newAssetBtn.addEventListener("click", () => {
      fillForm(null);
      assetModal.show();
    });
    if (newAssetInline) {
      newAssetInline.addEventListener("click", (e) => {
        e.preventDefault();
        fillForm(null);
        assetModal.show();
      });
    }

    const menu = document.getElementById('assetRowMenu');
    const editAction = document.getElementById('assetRowEdit');
    const deleteForm = document.getElementById('assetRowDelete');
    let activeRow;
    const hideMenu = (restoreFocus = false) => {
      menu.classList.remove('show');
      if (restoreFocus) activeRow?.focus();
    };
    const showMenu = (row, x, y) => {
      activeRow = row;
      deleteForm.action = `/asset/${encodeURIComponent(row.dataset.id)}?_method=DELETE`;
      menu.classList.add('show');
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
      editAction.focus();
    };
    editAction.addEventListener('click', () => {
      hideMenu();
      fillForm(JSON.parse(activeRow.dataset.asset));
      assetModal.show();
    });
    deleteForm.addEventListener('submit', event => {
      if (!window.confirm('この資産を削除しますか？ 過去の棚卸履歴は残ります。')) event.preventDefault();
      hideMenu(true);
    });
    document.querySelectorAll('.asset-management-row').forEach(row => {
      let timer, x, y, held = false;
      const cancel = () => clearTimeout(timer);
      row.addEventListener('contextmenu', event => {
        event.preventDefault(); cancel(); showMenu(row, event.clientX, event.clientY);
      });
      row.addEventListener('pointerdown', event => {
        cancel(); held = false;
        if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) return;
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
          event.preventDefault(); const rect = row.getBoundingClientRect(); showMenu(row, rect.left + 12, rect.top + 12);
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
        event.preventDefault(); const items = [...menu.querySelectorAll('[role="menuitem"]')];
        items[(items.indexOf(document.activeElement) + 1) % items.length].focus();
      }
    });

    assetForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (assetForm.dataset.saving === '1') return;
      const error = document.getElementById('assetFormError');
      const submit = assetForm.querySelector('[type="submit"]');
      assetForm.dataset.saving = '1'; submit.disabled = true; error.classList.add('d-none');
      try {
        const response = await fetch(assetForm.action, { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(assetForm)) });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || '保存できませんでした');
        window.location.href = '/asset/display#assetList';
      } catch (err) {
        error.textContent = err.message; error.classList.remove('d-none');
      } finally { submit.disabled = false; assetForm.dataset.saving = '0'; }
    });
    document.getElementById('assetModal').addEventListener('hidden.bs.modal', () => {
      passwordInput.value = ''; secureNoteField.value = ''; secureNoteField.disabled = true; editingAssetId = null;
    });

    unlockBtn.addEventListener("click", function () {
      authSection.style.display = "flex";
    });

    verifyBtn.addEventListener("click", async function () {
      const password = passwordInput.value.trim();

      if (!password) {
        alert("パスワードを入力してください");
        return;
      }

      if (!editingAssetId) {
        alert("資産IDが見つかりません（編集モードのみ対応）");
        return;
      }

      try {
        const res = await fetch(`/secure-note/${editingAssetId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });

        const result = await res.json();

        if (res.ok) {
          secureNoteField.value = result.secure_note;
          secureNoteField.removeAttribute("disabled");
          authSection.style.display = "none";
          unlockBtn.style.display = "none";
        } else {
          alert(result.error || "認証に失敗しました");
        }
      } catch (err) {
        console.error("Fetch error:", err);
        alert("取得中にエラーが発生しました");
      }
    });

    // クエリパラメータでモーダルを開く（displayからの導線用）
    const params = new URLSearchParams(window.location.search);
    if (params.get('open') === 'create') {
      fillForm(null);
      assetModal.show();
    } else if (params.get('assetId')) {
      const row = [...document.querySelectorAll('.asset-management-row')].find(row => row.dataset.id === params.get('assetId'));
      if (row) { fillForm(JSON.parse(row.dataset.asset)); assetModal.show(); }
    }
  });
