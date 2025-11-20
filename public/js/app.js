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