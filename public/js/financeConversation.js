(() => {
  const normalize = value => String(value || '').normalize('NFKC').trim().replace(/[\s　]/g, '');
  function parse(field, raw, values, options) {
    const value = normalize(raw);
    if (!value) throw new Error('回答を入力してください');
    if (field === 'date') {
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
      if (value.includes('今日')) return today;
      if (value.includes('昨日')) { const date = new Date(today); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
      const match = value.match(/^(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})日?$/);
      if (!match) throw new Error('日付を認識できませんでした。例：今日、昨日、11月3日');
      return `${match[1] || today.slice(0, 4)}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    }
    if (field === 'amount') {
      const amount = value.replace(/[円,，]/g, '');
      if (!/^-?\d+(?:\.\d+)?$/.test(amount)) throw new Error('金額を数字で回答してください');
      return amount;
    }
    if (['cf', 'category', 'payment_type'].includes(field)) {
      const list = field === 'cf' ? ['支出', '収入', '控除', '貯蓄'] : field === 'category' ? options.categories[values.cf] || [] : options.payments;
      const exact = list.find(option => normalize(option) === value);
      const matches = list.filter(option => value.includes(normalize(option)) || normalize(option).includes(value));
      if (exact || matches.length === 1) return exact || matches[0];
      throw new Error('表示されている選択肢から選んでください');
    }
    return String(raw).trim();
  }
  window.createFinanceConversation = ({ button, status, onAnswer }) => {
    let recognition, active = false, generation = 0, transcript = '';
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    function stop() {
      generation++; transcript = ''; active = false;
      recognition?.abort(); window.speechSynthesis?.cancel(); button.classList.remove('is-listening');
    }
    function listen() {
      if (!Recognition || active) return;
      window.speechSynthesis?.cancel(); transcript = '';
      const current = generation;
      const session = new Recognition(); recognition = session;
      session.lang = 'ja-JP'; session.interimResults = false; session.maxAlternatives = 1;
      session.addEventListener('result', event => { if (current === generation && session === recognition) transcript = event.results[0][0].transcript; });
      session.addEventListener('end', async () => {
        if (current !== generation || session !== recognition) return;
        active = false; button.classList.remove('is-listening');
        if (!transcript) { status.textContent = '音声を認識できませんでした。「話す」から再度入力できます。'; return; }
        const answer = transcript; transcript = ''; status.textContent = '';
        try { await onAnswer(answer); } catch (err) { status.textContent = err.message; }
      });
      session.addEventListener('error', event => {
        if (current !== generation || session !== recognition) return;
        active = false; transcript = ''; button.classList.remove('is-listening');
        if (event.error !== 'aborted') status.textContent = event.error === 'not-allowed' ? 'マイクの利用が許可されていません。文字で入力してください。' : '音声を認識できませんでした。もう一度お試しください。';
      });
      try { session.start(); active = true; button.classList.add('is-listening'); status.textContent = '聞き取り中です…'; }
      catch (_) { status.textContent = '「話す」を押すか、文字で入力してください。'; }
    }
    if (Recognition) {
      button.addEventListener('click', listen);
    } else { button.disabled = true; status.textContent = '音声入力に未対応のブラウザです。文字で入力できます。'; }
    return { stop, prompt(text, autoListen) {
      stop(); const current = generation;
      if (Recognition) status.textContent = '';
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const utterance = new window.SpeechSynthesisUtterance(text); utterance.lang = 'ja-JP';
      utterance.addEventListener('end', () => { if (current === generation && autoListen) listen(); });
      window.speechSynthesis.speak(utterance);
    } };
  };
  window.parseFinanceVoiceAnswer = parse;
})();
