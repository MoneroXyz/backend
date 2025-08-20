(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d=8) => Number(n ?? 0).toFixed(d).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "");

  // Conservative "hint floors" ONLY to choose the message on 5xx.
  const HINT_MIN = { USDT: 12, USDC: 12, BTC: 0.0003, ETH: 0.01, LTC: 0.1 };

  const ASSETS = [
    { symbol: "BTC",  label: "BTC",  icon: "icon-btc",  defaultNet: "BTC" },
    { symbol: "ETH",  label: "ETH",  icon: "icon-eth",  defaultNet: "ETH" },
    { symbol: "USDT", label: "USDT", icon: "icon-usdt", defaultNet: "TRX" },
    { symbol: "USDC", label: "USDC", icon: "icon-usdc", defaultNet: "ETH" },
    { symbol: "LTC",  label: "LTC",  icon: "icon-ltc",  defaultNet: "LTC" }
  ];
  const USDT_NETS = [
    { value: "ETH", label: "ERC20", icon: "icon-eth" },
    { value: "TRX", label: "TRC20", icon: "icon-trx" },
    { value: "BSC", label: "BEP20", icon: "icon-bnb" }
  ];

  let lastQuote = null, debounceId = null, quoteSeq = 0;

  /* ---------- IconSelect (custom dropdown) ---------- */
  class IconSelect {
    constructor(root, items, def, isChip=false){
      this.root=root; this.items=items;
      this.value = def || items[0].value || items[0].symbol;
      this.root.classList.add("mx-select"); if (isChip) this.root.classList.add("mx-select--chip");
      this.btn = document.createElement("button"); this.btn.type="button"; this.btn.className="mx-select__btn";
      this.btn.setAttribute("aria-haspopup","listbox");
      this.btn.addEventListener("click",(e)=>{e.stopPropagation();this.toggle();});
      this.icon = document.createElementNS("http://www.w3.org/2000/svg","svg"); this.icon.classList.add("mx-select__icon");
      const use = document.createElementNS("http://www.w3.org/2000/svg","use"); this._useEl = use;
      this.icon.setAttribute("viewBox","0 0 18 18"); this.icon.appendChild(use);
      this.label = document.createElement("span"); this.label.className="mx-select__label";
      this.btn.appendChild(this.icon); this.btn.appendChild(this.label);
      this.list = document.createElement("div"); this.list.className="mx-select__list"; this.list.setAttribute("role","listbox");
      this.list.addEventListener("click",(e)=>e.stopPropagation());
      this.root.appendChild(this.btn); this.root.appendChild(this.list);
      this.renderOptions(); this.renderButton();
      document.addEventListener("click",()=>this.close());
      this.root.addEventListener("keydown",(e)=>{ if(e.key==="Escape")this.close(); if(e.key==="Enter"||e.key===" "){this.toggle(); e.preventDefault();}});
    }
    renderOptions(){
      this.list.innerHTML="";
      for(const it of this.items){
        const val = it.value ?? it.symbol;
        const opt = document.createElement("div"); opt.className="mx-option"; opt.setAttribute("role","option"); opt.setAttribute("data-value",val);
        if(it.icon){ const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"); svg.classList.add("mx-option__icon");
          const use=document.createElementNS("http://www.w3.org/2000/svg","use"); use.setAttributeNS("http://www.w3.org/1999/xlink","href",`#${it.icon}`);
          svg.appendChild(use); opt.appendChild(svg); }
        const lb=document.createElement("span"); lb.className="mx-option__label"; lb.textContent=it.label ?? val;
        opt.appendChild(lb); opt.addEventListener("click",()=>this.set(val)); this.list.appendChild(opt);
      }
    }
    renderButton(){
      const it=this.items.find(a=>(a.value??a.symbol)===this.value) || this.items[0];
      if(it?.icon){ this._useEl.setAttributeNS("http://www.w3.org/1999/xlink","href",`#${it.icon}`); this.icon.style.display=""; }
      else this.icon.style.display="none";
      this.label.textContent = it.label ?? it.value ?? it.symbol;
      [...this.list.children].forEach(ch=>ch.setAttribute("aria-selected",ch.getAttribute("data-value")===this.value?"true":"false"));
    }
    set(v){ this.value=v; this.renderButton(); this.close(); this.onchange && this.onchange(v); }
    setItems(items,preserve=true){ const prev=this.value; this.items=items; this.renderOptions();
      if(preserve && items.some(it=>(it.value??it.symbol)===prev)) this.value=prev;
      else this.value = items[0]?.value ?? items[0]?.symbol ?? "";
      this.renderButton();
    }
    toggle(){ this.root.classList.toggle("open"); } close(){ this.root.classList.remove("open"); } getValue(){ return this.value; }
  }

  let inAssetSel, outAssetSel, inNetSel, outNetSel;

  const assetItems = ASSETS.map(a=>({symbol:a.symbol,label:a.label,icon:a.icon}));
  const isUSDT = (s)=> s==="USDT";
  const defaultNetFor = (s)=> ASSETS.find(a=>a.symbol===s)?.defaultNet || "";

  function applyNetworkVisibility(){
    const inIsUSDT=isUSDT(inAssetSel.getValue()), outIsUSDT=isUSDT(outAssetSel.getValue());
    $("inNet").hidden=!inIsUSDT; $("outNet").hidden=!outIsUSDT;
    if(inIsUSDT && !USDT_NETS.find(n=>n.value===inNetSel.getValue())) inNetSel.set("TRX");
    if(outIsUSDT && !USDT_NETS.find(n=>n.value===outNetSel.getValue())) outNetSel.set("ETH");
  }
  function currentNetworks(){
    const i=inAssetSel.getValue(), o=outAssetSel.getValue();
    return { in: isUSDT(i)?inNetSel.getValue():defaultNetFor(i), out: isUSDT(o)?outNetSel.getValue():defaultNetFor(o) };
  }

  function updateRateLine(best, req){
    const line=$("rateLine");
    if(!best||!req){ line.textContent="Estimated rate: —"; return; }
    const rate = Number(req.amount)>0 ? (best.receive_out/req.amount) : 0;
    line.textContent=`Estimated rate: 1 ${req.in_asset} ~ ${fmt(rate,6)} ${req.out_asset}`;
  }

  // Enhanced: can mark “bad” (red + bold) or “loading”
  function setQuoteState(text, loading=false, isBad=false){
    const el = $("quoteState");
    el.textContent = text;
    el.classList.toggle("mx-loading", !!loading);
    if (isBad) {
      el.style.color = "#ff6a6a";
      el.style.fontWeight = "800";
    } else {
      el.style.color = "";         // reset to CSS default
      el.style.fontWeight = "";    // reset
    }
  }

  function clearDisplayForRequote(){ $("outAmount").value=""; $("outAmount").placeholder="—"; $("btnExchange").disabled=true; setQuoteState("Recalculating…",true,false); }
  function clearDisplayAll(){ $("outAmount").value="—"; $("btnExchange").disabled=true; }

  // Address validation
  const re = {
    ethLike:/^0x[a-fA-F0-9]{40}$/, tron:/^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    btc:/^(bc1[0-9a-z]{25,39}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, ltc:/^(ltc1[0-9a-z]{25,39}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/
  };
  function validateAddress(asset, net, addr){
    if(!addr || addr.length<10) return {ok:false,msg:"Enter destination address."};
    const up=asset.toUpperCase(), n=(net||"").toUpperCase();
    if(up==="ETH" || (up==="USDT"&&n==="ETH") || up==="USDC") return re.ethLike.test(addr)?{ok:true}:{ok:false,msg:"Address must start with 0x… (Ethereum-style)"};
    if(up==="USDT" && n==="BSC") return re.ethLike.test(addr)?{ok:true}:{ok:false,msg:"BEP20 address must start with 0x…"};
    if(up==="USDT" && n==="TRX") return re.tron.test(addr)?{ok:true}:{ok:false,msg:"TRC20 address must start with T…"};
    if(up==="BTC") return re.btc.test(addr)?{ok:true}:{ok:false,msg:"Invalid BTC address."};
    if(up==="LTC") return re.ltc.test(addr)?{ok:true}:{ok:false,msg:"Invalid LTC address."};
    return {ok:true};
  }
  function updatePayoutValidity(){
    const outSym=outAssetSel.getValue(), nets=currentNetworks();
    const res=validateAddress(outSym, nets.out, $("payout").value.trim());
    const hint=$("payoutHint");
    if(!res.ok){ hint.textContent=res.msg; hint.classList.add("mx-bad"); hint.hidden=false; }
    else { hint.textContent=""; hint.classList.remove("mx-bad"); hint.hidden=true; }
    updateExchangeEnabled();
  }
  function updateExchangeEnabled(){
    const payoutOk = $("payoutHint").hidden && $("payout").value.trim().length>0;
    $("btnExchange").disabled = !(lastQuote && payoutOk);
  }

  // Parse provider minimums from backend payloads (JSON or text)
  function parseMinFromErrorPayload(payload){
    try{
      if(typeof payload==="string"){
        const m = payload.match(/min(?:imum)?[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
        if(m) return {found:true,min:Number(m[1])};
        return {found:false};
      }
      if(payload && typeof payload==="object"){
        const cand = payload.min_in ?? payload.minimum ?? payload.min ?? payload.min_amount ?? payload?.limits?.min_in ?? payload?.constraints?.min_in;
        if(cand) return {found:true,min:Number(cand)};
        for (const k of ["detail","message","error"]) {
          const s = payload[k];
          if (typeof s === "string") {
            const m = s.match(/min(?:imum)?[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
            if (m) return {found:true,min:Number(m[1])};
          }
        }
      }
    }catch{}
    return {found:false};
  }

  async function autoQuote(){
    const amountStr = $("inAmount").value;
    const amount = Number(amountStr);
    if(!amountStr || amountStr.trim()===""){ lastQuote=null; clearDisplayAll(); updateRateLine(null,null); setQuoteState("Enter amount to get a quote.", false, false); updateExchangeEnabled(); return; }
    if(!Number.isFinite(amount) || amount<=0){ lastQuote=null; clearDisplayAll(); updateRateLine(null,null); setQuoteState("Enter a positive amount.", false, true); updateExchangeEnabled(); return; }

    const inSym=inAssetSel.getValue(), outSym=outAssetSel.getValue(), nets=currentNetworks();
    const req = { in_asset:inSym, in_network:nets.in, out_asset:outSym, out_network:nets.out, amount, rate_type:"float" };

    const mySeq=++quoteSeq;
    $("mxErr").hidden=true; setQuoteState("Finding best route…", true, false); $("btnExchange").disabled=true; lastQuote=null;

    try{
      const r = await fetch("/api/quote", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(req) });

      if(!r.ok){
        let payloadText=null, payloadJson=null;
        try { payloadJson = await r.json(); } catch { try { payloadText = await r.text(); } catch {} }
        const parsed = parseMinFromErrorPayload(payloadJson ?? payloadText ?? "");

        if (parsed.found) {
          lastQuote=null; clearDisplayAll(); updateRateLine(null,null);
          setQuoteState("Below minimum", false, true);
          updateExchangeEnabled();
          return;
        }

        // 5xx and typed amount is clearly tiny -> it's likely a min case: show "Below minimum".
        if (r.status >= 500 && amount < (HINT_MIN[inSym] ?? 0)) {
          lastQuote=null; clearDisplayAll(); updateRateLine(null,null);
          setQuoteState("Below minimum", false, true);
          updateExchangeEnabled();
          return;
        }

        const msg = (r.status >= 500) ? "Service is busy. Please try again in a moment." : `Quote failed (${r.status}).`;
        throw new Error(msg);
      }

      const data = await r.json();
      if(mySeq!==quoteSeq) return;
      const best = (data?.options || [])[0];
      if(!best){
        const minCand = data?.limits?.min_in || data?.constraints?.min_in;
        if(minCand){ lastQuote=null; clearDisplayAll(); updateRateLine(null,null); setQuoteState("Below minimum", false, true); updateExchangeEnabled(); return; }
        throw new Error("No route found");
      }
      lastQuote = { best, request: data.request };
      $("outAmount").value = fmt(best.receive_out);
      updateRateLine(best, data.request);
      setQuoteState("Route found ✓", false, false);
    }catch(e){
      if(mySeq!==quoteSeq) return;
      lastQuote=null; clearDisplayAll();
      $("mxErr").textContent=String(e.message||e); $("mxErr").hidden=false;
      updateRateLine(null,null); setQuoteState("Unable to quote. Adjust amount, asset, or network.", false, true);
    }finally{ updatePayoutValidity(); }
  }

  function onChangeDebounced(){ if(debounceId) clearTimeout(debounceId); clearDisplayForRequote(); debounceId=setTimeout(autoQuote,220); }
  function swapInOut(){ const a=inAssetSel.getValue(); inAssetSel.set(outAssetSel.getValue()); outAssetSel.set(a); applyNetworkVisibility(); onChangeDebounced(); }

  async function startExchange(){
    if(!lastQuote) return alert("No quote yet.");
    const payout=$("payout").value.trim(); updatePayoutValidity(); if($("btnExchange").disabled) return;
    const {best,request}=lastQuote;
    const body={ leg1_provider:best.leg1.provider, leg2_provider:best.leg2.provider, in_asset:request.in_asset, in_network:request.in_network,
      out_asset:request.out_asset, out_network:request.out_network, amount:request.amount, payout_address:payout, rate_type:request.rate_type,
      our_fee_xmr:Number(best?.fee?.our_fee_xmr||0), refund_address_user: ($("refund").value.trim()||null) };
    const btn=$("btnExchange"); btn.disabled=true;
    try{
      const r=await fetch("/api/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const j=await r.json(); if(!r.ok) throw new Error(j?.detail||JSON.stringify(j));
      const url=new URL("./checkout.html",window.location.href); url.searchParams.set("sid", j.swap_id); window.location.href=url.toString();
    }catch(e){ alert("Start failed: " + (e.message||e)); } finally{ btn.disabled=false; }
  }

  document.addEventListener("DOMContentLoaded", ()=>{
    inAssetSel  = new IconSelect($("inAsset"),  assetItems, "USDT");
    outAssetSel = new IconSelect($("outAsset"), assetItems, "ETH");
    inNetSel  = new IconSelect($("inNet"),  USDT_NETS, "TRX", true);
    outNetSel = new IconSelect($("outNet"), USDT_NETS, "ETH", true);

    inAssetSel.onchange=()=>{applyNetworkVisibility(); onChangeDebounced();};
    outAssetSel.onchange=()=>{applyNetworkVisibility(); onChangeDebounced();};
    inNetSel.onchange=onChangeDebounced; outNetSel.onchange=onChangeDebounced;

    $("inAmount").value=""; $("inAmount").addEventListener("input", onChangeDebounced);
    $("payout").addEventListener("input", updatePayoutValidity);
    $("swapBtn").addEventListener("click", swapInOut);
    $("btnExchange").addEventListener("click", startExchange);

    applyNetworkVisibility(); clearDisplayAll(); setQuoteState("Enter amount to get a quote.", false, false);
  });
})();
