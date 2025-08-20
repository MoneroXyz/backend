(() => {
  const $ = (id) => document.getElementById(id);
  const qs = (k, d=null) => new URLSearchParams(window.location.search).get(k) || d;

  function renderQR(targetEl, text){
    const img = new Image();
    img.alt = 'QR';
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(text)}`;
    targetEl.innerHTML = '';
    targetEl.appendChild(img);
  }

  function mapTimelineToWidget(tl=[]){
    const has = (k) => tl.includes(k);
    const receiving = has('waiting_deposit') || has('leg1_processing') || (!has('leg1_complete'));
    const routing   = has('awaiting_wallet_unlocked') || has('routing_xmr_to_leg2');
    const sending   = has('leg2_processing');
    const complete  = has('complete');
    return { receiving, routing, sending, complete };
  }

  function paintSteps(b){
    const keys = ['receiving','routing','sending','complete'];
    keys.forEach(k => {
      const el = document.querySelector(`.mx-step[data-k="${k}"]`);
      if (!el) return;
      el.classList.toggle('on', !!b[k]);
    });
  }

  async function hydrateDeposit(){
    const sid = qs('sid');
    if (!sid) return;
    try{
      const r = await fetch(`/api/status/${encodeURIComponent(sid)}`);
      const s = await r.json();
      const addr = s?.deposit?.address || s?.leg1?.deposit_address || s?.deposit_address || '—';
      const memo = s?.deposit?.extra || s?.leg1?.deposit_extra || s?.deposit_extra || '';
      $("depositAddr").textContent = addr;
      if (memo) { $("memoWrap").textContent = `Memo/Tag: ${memo}`; $("memoWrap").hidden = false; }
      renderQR($("qr"), addr + (memo?`?memo=${memo}`:''));
      updateStatus(s);
    }catch(e){
      console.error(e);
    }
  }

  async function pollStatus(){
    const sid = qs('sid');
    if (!sid) return;
    try{
      const r = await fetch(`/api/status/${encodeURIComponent(sid)}`);
      const s = await r.json();
      updateStatus(s);
    }catch(e){ console.error(e); }
  }

  function updateStatus(s){
    const tl = Array.isArray(s?.timeline) ? s.timeline : [];
    const mapped = mapTimelineToWidget(tl);
    paintSteps(mapped);
  }

  function startCountdown(hours = 2){
    const end = Date.now() + hours * 3600 * 1000;
    const el = $("countdown");
    function tick(){
      const diff = Math.max(0, end - Date.now());
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000)/60000);
      const s = Math.floor((diff % 60000)/1000);
      el.textContent = `${String(h).padStart(1,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (diff <= 0) clearInterval(t);
    }
    tick();
    const t = setInterval(tick, 1000);
  }

  function copy(text){ navigator.clipboard?.writeText(text).catch(()=>{}); }

  document.addEventListener('DOMContentLoaded', () => {
    hydrateDeposit();
    startCountdown(2);
    setInterval(pollStatus, 3000);
    $("copyBtn").addEventListener('click', ()=> copy($("depositAddr").textContent || ''));
  });
})();
