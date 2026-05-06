(function () {
    // --- カテゴリ表示制御 ---
    const largeCf = document.getElementById("cf");
    const expenseGroup = document.getElementById("expense_group");
    const incomeGroup = document.getElementById("income_group");
    const deductionGroup = document.getElementById("deduction_group");
    const savingGroup = document.getElementById("saving_group");

    function updateCategories() {
        if (!largeCf || !incomeGroup || !expenseGroup || !deductionGroup || !savingGroup) {
            // console.warn("カテゴリグループの要素が見つかりません");
            return;
        }

        expenseGroup.style.display = "none";
        incomeGroup.style.display = "none";
        deductionGroup.style.display = "none";
        savingGroup.style.display = "none";

        if (largeCf.value === "支出") {
            expenseGroup.style.display = "block";
        } else if (largeCf.value === "収入") {
            incomeGroup.style.display = "block";
        } else if (largeCf.value === "控除") {
            deductionGroup.style.display = "block";
        } else if (largeCf.value === "貯蓄") {
            savingGroup.style.display = "block";
        }
    }

    window.updateCategories = updateCategories;

    updateCategories();
    if (largeCf) {
        largeCf.addEventListener("change", updateCategories);
    }
})();

// --- Finance close buttons (draggable + persisted) ---
(function () {
    const stack = document.getElementById("finance-close-stack");
    const monthFab = document.getElementById("finance-close-fab");
    const yearFab = document.getElementById("finance-close-year-fab");
    if (!stack) return;

    const storageKey = "financeCloseStackPos";
    const dragThreshold = 4;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const applyPosition = (x, y) => {
        const rect = stack.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        const clampedX = clamp(x, 8, Math.max(8, maxX));
        const clampedY = clamp(y, 8, Math.max(8, maxY));
        stack.style.left = `${clampedX}px`;
        stack.style.top = `${clampedY}px`;
        stack.style.right = "auto";
        stack.style.bottom = "auto";
        return { x: clampedX, y: clampedY };
    };

    const loadPosition = () => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
                applyPosition(parsed.x, parsed.y);
            }
        } catch (_) {
            // ignore
        }
    };

    const savePosition = (pos) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(pos));
        } catch (_) {
            // ignore
        }
    };

    loadPosition();

    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;
    let dragging = false;

    const beginDrag = (clientX, clientY) => {
        const rect = stack.getBoundingClientRect();
        startX = clientX;
        startY = clientY;
        originX = rect.left;
        originY = rect.top;
        moved = false;
        dragging = true;
    };

    const moveDrag = (clientX, clientY, event) => {
        if (!dragging) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (!moved && Math.hypot(dx, dy) > dragThreshold) {
            moved = true;
        }
        if (moved) {
            const pos = applyPosition(originX + dx, originY + dy);
            savePosition(pos);
            if (event) event.preventDefault();
        }
    };

    const endDrag = () => {
        dragging = false;
    };

    [monthFab, yearFab].forEach((el) => {
        if (!el) return;
        el.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 && event.pointerType === "mouse") return;
            beginDrag(event.clientX, event.clientY);
        });
        el.addEventListener("mousedown", (event) => {
            if (event.button !== 0) return;
            beginDrag(event.clientX, event.clientY);
        });
        el.addEventListener("touchstart", (event) => {
            const touch = event.touches[0];
            if (!touch) return;
            beginDrag(touch.clientX, touch.clientY);
        }, { passive: true });
        el.addEventListener("dragstart", (event) => {
            event.preventDefault();
        });
        el.addEventListener("click", (event) => {
            if (moved) {
                event.preventDefault();
            }
        });
    });

    window.addEventListener("pointermove", (event) => {
        moveDrag(event.clientX, event.clientY, event);
    });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("mousemove", (event) => {
        moveDrag(event.clientX, event.clientY, event);
    });
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("touchmove", (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        moveDrag(touch.clientX, touch.clientY, event);
    }, { passive: false });
    window.addEventListener("touchend", endDrag);
    window.addEventListener("touchcancel", endDrag);

    window.addEventListener("resize", () => {
        const rect = stack.getBoundingClientRect();
        if (stack.style.left && stack.style.top) {
            const pos = applyPosition(rect.left, rect.top);
            savePosition(pos);
        }
    });
})();


// --- 年・日付入力制御 ---
const yearInput = document.getElementById("year");
const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");

if (yearInput && fromInput && toInput) {
    function toggleDateFields() {
        fromInput.disabled = !!yearInput.value.trim();
        toInput.disabled = !!yearInput.value.trim();
    }

    function toggleYearField() {
        yearInput.disabled = !!(fromInput.value.trim() || toInput.value.trim());
    }

    yearInput.addEventListener("input", toggleDateFields);
    fromInput.addEventListener("input", toggleYearField);
    toInput.addEventListener("input", toggleYearField);

    toggleDateFields();
    toggleYearField();
}


async function duplicateFinance(id) {
    try {
        const response = await fetch(`/finance/${id}/duplicate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();
        if (response.ok) {
            // 複製されたデータの編集ページへリダイレクト
            window.location.href = `/finance/${data.newId}/edit`;
        } else {
            console.error('複製エラー:', data.message);
            alert('複製できませんでした。');
        }
    } catch (error) {
        console.error('エラー:', error);
        alert('エラーが発生しました。');
    }
}


async function confirmExport() {
    const form = document.getElementById('export-form');
    const params = new URLSearchParams();

    const year = form.elements['year']?.value?.trim();
    const from = form.elements['from']?.value?.trim();
    const to = form.elements['to']?.value?.trim();
    const user = form.elements['user']?.value?.trim();

    if (year) params.append('year', year);
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    if (user) params.append('user', user);

    params.append('countOnly', 'true');

    console.log('✅ 実際に送信するパラメータ:', params.toString()); // ← ここで要確認

    const res = await fetch(`/export/count?${params.toString()}`);
    const data = await res.json();

    const message = `
以下の条件で書き出しますか？

年: ${year || '未指定'}
日付: ${from || '未指定'} ～ ${to || '未指定'}
対象者: ${user ? form.user.options[form.user.selectedIndex].text : '全員'}

該当件数: ${data.count} 件
    `;

    if (confirm(message)) {
        console.log("フォームを送信します");
        form.submit();  // ここでフォーム送信を実行
    }
}

//フォーム送信前に JavaScript で空白に置き換える（ページ内全てのフォームに対応する）
document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function(event) {
      const selectElements = form.querySelectorAll('select');
  
      selectElements.forEach(select => {
        if (select.value === 'Please Choice') {
          select.value = '';
        }
      });
    });
});

function renderTags(tags) {
    const tagDisplayArea = document.getElementById("tagDisplayArea");
    tagDisplayArea.innerHTML = '';
    if (!tags || tags.length === 0) {
        tagDisplayArea.innerHTML = '<span class="text-muted">タグはまだありません。</span>';
        return;
    }
    tags.forEach(tag => {
        const name = typeof tag === 'string' ? tag : tag.name;
        const span = document.createElement('span');
        span.className = 'badge bg-secondary me-1';
        span.textContent = name;
        tagDisplayArea.appendChild(span);

        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = 'finance[tags][]';
        hiddenInput.value = name;
        tagDisplayArea.appendChild(hiddenInput);
    });
}

// --- Finance quick floating menu (draggable + persisted) ---
(function () {
    const fab = document.getElementById("finance-quick-fab");
    const toggles = Array.from(document.querySelectorAll("[data-finance-quick-toggle]"));
    if (!fab && toggles.length === 0) return;

    const handle = fab?.querySelector(".finance-quick-fab-handle");
    const groupSwitch = fab?.querySelector('[data-finance-quick-action="group-switch"]');
    const storageKey = "financeQuickFabPos";
    const dragThreshold = 4;
    let syncing = false;

    const setQuickMenuEnabled = (enabled) => {
        if (fab) {
            fab.dataset.financeQuickEnabled = enabled ? "true" : "false";
            fab.classList.toggle("is-disabled", !enabled);
        }
        toggles.forEach((toggle) => {
            toggle.checked = enabled;
        });
    };

    const persistQuickMenuEnabled = async (enabled) => {
        const response = await fetch("/api/settings/finance-quick-menu", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled })
        });
        if (!response.ok) throw new Error("Failed to update quick menu setting");
        const data = await response.json();
        return data.enabled !== false;
    };

    toggles.forEach((toggle) => {
        toggle.addEventListener("change", async () => {
            if (syncing) return;
            const nextEnabled = toggle.checked;
            const previousEnabled = !nextEnabled;
            syncing = true;
            setQuickMenuEnabled(nextEnabled);
            try {
                const savedEnabled = await persistQuickMenuEnabled(nextEnabled);
                setQuickMenuEnabled(savedEnabled);
            } catch (_) {
                setQuickMenuEnabled(previousEnabled);
                window.alert("よく使う項目の表示設定を更新できませんでした。時間をおいて再度お試しください。");
            } finally {
                syncing = false;
            }
        });
    });

    if (!fab) return;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const applyPosition = (x, y) => {
        const rect = fab.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        const clampedX = clamp(x, 8, Math.max(8, maxX));
        const clampedY = clamp(y, 8, Math.max(8, maxY));
        fab.style.left = `${clampedX}px`;
        fab.style.top = `${clampedY}px`;
        fab.style.right = "auto";
        fab.style.bottom = "auto";
        return { x: clampedX, y: clampedY };
    };

    const loadPosition = () => {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
                applyPosition(parsed.x, parsed.y);
            }
        } catch (_) {
            // ignore
        }
    };

    const savePosition = (pos) => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(pos));
        } catch (_) {
            // ignore
        }
    };

    loadPosition();

    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;
    let dragging = false;

    const beginDrag = (clientX, clientY) => {
        const rect = fab.getBoundingClientRect();
        startX = clientX;
        startY = clientY;
        originX = rect.left;
        originY = rect.top;
        moved = false;
        dragging = true;
    };

    const moveDrag = (clientX, clientY, event) => {
        if (!dragging) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (!moved && Math.hypot(dx, dy) > dragThreshold) {
            moved = true;
        }
        if (moved) {
            const pos = applyPosition(originX + dx, originY + dy);
            savePosition(pos);
            if (event) event.preventDefault();
        }
    };

    const endDrag = () => {
        dragging = false;
    };

    const openGroupMenu = () => {
        const menuToggle = document.querySelector('[data-bs-target="#offcanvasMenu"]');
        if (menuToggle) {
            menuToggle.click();
            window.setTimeout(() => {
                const groupSelect = document.querySelector('#offcanvasMenu select[name="groupId"]');
                if (groupSelect) groupSelect.focus();
            }, 250);
        }
    };

    if (groupSwitch) {
        groupSwitch.addEventListener("click", openGroupMenu);
    }

    if (!handle) return;

    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        beginDrag(event.clientX, event.clientY);
    });

    window.addEventListener("pointermove", (event) => {
        moveDrag(event.clientX, event.clientY, event);
    });

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    handle.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        beginDrag(event.clientX, event.clientY);
    });

    window.addEventListener("mousemove", (event) => {
        moveDrag(event.clientX, event.clientY, event);
    });

    window.addEventListener("mouseup", endDrag);

    handle.addEventListener("touchstart", (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        beginDrag(touch.clientX, touch.clientY);
    }, { passive: true });

    window.addEventListener("touchmove", (event) => {
        const touch = event.touches[0];
        if (!touch) return;
        moveDrag(touch.clientX, touch.clientY, event);
    }, { passive: false });

    window.addEventListener("touchend", endDrag);
    window.addEventListener("touchcancel", endDrag);

    handle.addEventListener("dragstart", (event) => {
        event.preventDefault();
    });

    handle.addEventListener("click", (event) => {
        if (moved) {
            event.preventDefault();
        }
    });

    window.addEventListener("resize", () => {
        const rect = fab.getBoundingClientRect();
        if (fab.style.left && fab.style.top) {
            const pos = applyPosition(rect.left, rect.top);
            savePosition(pos);
        }
    });
})();
