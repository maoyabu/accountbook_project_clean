document.addEventListener("DOMContentLoaded", function () {

  document.querySelectorAll('form:not(.no-js-submit)').forEach(form => {
    form.addEventListener('submit', event => {
      //console.log("フォーム送信イベント ✅");

      const button = event.submitter;
      const spinner = button?.parentElement.querySelector('.spinner-border');

      if (button) {
        button.disabled = true;
        button.textContent = '送信中...';
      }

      if (spinner) {
        spinner.classList.remove('d-none');
        //console.log("スピナー表示 ✅");
      } else {
        //console.log("スピナーが見つかりません ⚠️");
      }
    });
  });
});

const form = document.querySelector('form:not(.no-js-submit)');
const budgetArea = document.getElementById('budgetFormArea');
if (form && budgetArea) {
    form.addEventListener('submit', async function(e) {
  e.preventDefault();

  const formData = new FormData(this);
  const params = new URLSearchParams();
  for (const [key, value] of formData.entries()) {
    params.append(key, value);
  }

  try {
    const res = await fetch('/group/budget/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('⚠️ fetchエラー:', res.status, errorText);
      budgetArea.innerHTML = `<div class="alert alert-danger">エラーが発生しました（${res.status}）</div>`;
      return;
    }

    const html = await res.text();
    budgetArea.innerHTML = html;
  } catch (err) {
    console.error('❌ fetch通信エラー:', err);
    budgetArea.innerHTML = `<div class="alert alert-danger">通信に失敗しました</div>`;
  }
  });
}

function removeRow(btn) {
    btn.closest('tr').remove();
}

function addRow() {
    const tbody = document.getElementById('budgetTableBody');
    const index = tbody.children.length;
    const row = document.createElement('tr');
    row.innerHTML = `
    <td><input type="text" name="items[${index}][expense_item]" class="form-control" required></td>
    <td><input type="number" name="items[${index}][budget]" value="0" class="form-control" required></td>
    <td><button type="button" class="btn btn-danger btn-sm" onclick="removeRow(this)">削除</button></td>
    `;
    tbody.appendChild(row);
}

//spinnerのグローバルに適用する共通スクリプト
document.addEventListener("DOMContentLoaded", function () {

  document.querySelectorAll('form:not(.no-js-submit)').forEach(form => {
    form.addEventListener('submit', event => {
      //console.log("フォーム送信イベント ✅");

      const button = event.submitter;
      const spinner = button?.parentElement.querySelector('.spinner-border');

      if (button) {
        button.disabled = true;
        button.textContent = '送信中...';
      }

      if (spinner) {
        spinner.classList.remove('d-none');
        //console.log("スピナー表示 ✅");
      } else {
        //console.log("スピナーが見つかりません ⚠️");
      }
    });
  });
});

// OCR結果をフォームに反映する関数(new.ejs用)
async function analyzeReceiptNew() {
  const fileInput = document.getElementById('receiptImage');
  const file = fileInput?.files[0];

  if (!file) {
    alert('画像ファイルを選択してください');
    return;
  }

  const formData = new FormData();
  formData.append('receiptImage', file);

  try {
    const res = await fetch('/finance/ocrNew', {
      method: 'POST',
      headers: {
        'Accept': 'application/json'
      },
      body: formData
    });

    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const fallbackText = await res.text();
      console.error('⚠️ Unexpected response (not JSON):', fallbackText);
      alert('OCR通信エラー：サーバーから不正な応答が返されました。詳細は開発者ツールでご確認ください。');
      //console.log('📄 サーバー応答の内容:\n', fallbackText);
      return;
    }

    const data = await res.json();
    // console.log(data.tags);
    if (data.success) {
      const contentField = document.getElementById('content');
      if (contentField) {
        contentField.value = data.storeName || '';
      }
      if (data.amount) {
        const amountField = document.getElementById('amount');
        if (amountField) amountField.value = data.amount;
        // set cf (収支区分) to "支出" and update categories section
        const cfSelect = document.getElementById('cf');
      }
      if (typeof data.date === 'string' && data.date.length > 0) {
        const dateField = document.getElementById('date');
        if (dateField) {
          dateField.value = data.date;
        }
      }
    // console.log(data.tags);
      // タグの表示と hidden input の生成
      // ログ追加
      console.log('✅ typeof data.tags =', typeof data.tags);
      console.log('✅ isArray =', Array.isArray(data.tags));
      console.log('✅ has length =', data.tags?.length);
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        if (typeof renderTagsNew === 'function') {
          renderTagsNew(data.tags);  // オブジェクトのまま渡すよう
        } else {
          console.warn("⚠️ renderTagsNew 関数が定義されていません");
        }
      }

      // alert('OCR結果をフォームに反映しました');
      let missingFields = [];
      if (!data.storeName) missingFields.push('店舗名');
      if (!data.amount) missingFields.push('金額');
      if (!data.date) missingFields.push('日付');

      let message = 'OCR結果をフォームに反映しました';
      if (missingFields.length > 0) {
        message += `（${missingFields.join('・')}が読み取れませんでした）`;
      }

      showCustomAlert(message, 'success');
    } else {
      alert(data.message || 'OCRに失敗しました');
    }
  } catch (error) {
    console.error('analyzeReceiptNew error:', error);
    alert('OCR通信エラー: ' + error.message);
  }
}

function showCustomAlert(message, type = 'warning') {
  const alertBox = document.getElementById('customAlert');
  const alertMessage = document.getElementById('customAlertMessage');

  if (alertBox && alertMessage) {
    alertMessage.textContent = message;
    alertBox.className = `alert alert-${type} alert-dismissible fade show`; // `type`: success, warning, danger
    alertBox.classList.remove('d-none');

    // 5秒後に自動で消える
    setTimeout(() => {
      hideCustomAlert();
    }, 5000);
  }
}

function hideCustomAlert() {
  const alertBox = document.getElementById('customAlert');
  if (alertBox) {
    alertBox.classList.add('d-none');
  }
}