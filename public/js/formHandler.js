// public/js/formHandler.js

document.addEventListener('DOMContentLoaded', () => {
    // 全てのフォームを対象にする
    const forms = document.querySelectorAll('form[data-loading]');
  
    forms.forEach(form => {
      form.addEventListener('submit', () => {
        const btn = form.querySelector('button[type="submit"]');
        const spinner = form.querySelector('.spinner-border');
  
        if (btn) {
          btn.disabled = true;
          btn.textContent = '送信中...';
        }
        if (spinner) {
          spinner.classList.remove('d-none');
        }
      });
    });
  });