// Monerizer UI v5.1 (auto leg2 + correct 'Sending XMR')
(function(){
  console.log("Monerizer UI v5.1 loaded");

  function $(s){ return document.querySelector(s); }
  var UI = {
    in_pair: $("#in_pair"), out_pair: $("#out_pair"),
    amount: $("#amount"), rate: $("#rate_type"), btnQuote: $("#btnQuote"),
    routesWrap: $("#routesWrap"), bestRoute: $("#bestRoute"),
    toggleOthers: $("#toggleOthers"), otherRoutes: $("#otherRoutes"),
    leg1: $("#leg1_provider"), leg2: $("#leg2_provider"),
    payout: $("#payout_address"), btnStart: $("#btnStart"),
    sr: $("#startResult"), sr_id: $("#sr_id"), sr_dep: $("#sr_dep"), sr_extra: $("#sr_extra"), sr_extra_row: $("#sr_extra_row"), btnCopy: $("#btnCopy"),
    swap: $("#swap_id"), btnStatus: $("#btnStatus"), btnWatch: $("#btnWatch"), btnStop: $("#btnStop"),
    statusPanel: $("#statusPanel"), accounting: $("#accounting"), toast: $("#toast")
  };
  var last = { request:null, options:[], best_index:-1, chosen:null, watcher:null };

  var PAIRS = [
    { value:"ETH|ETH",  label:"ETH (ETH)"  },
    { value:"BTC|BTC",  label:"BTC (BTC)"  },
    { value:"LTC|LTC",  label:"LTC (LTC)"  },
    { value:"USDT|ETH", label:"USDT (ETH)" },
    { value:"USDT|TRX", label:"USDT (TRX)" },
    { value:"USDC|ETH", label:"USDC (ETH)" }
  ];

  function fillPairSelect(sel, defVal){
    var html = "";
    for (var i=0;i<PAIRS.length;i++){ html += '<option value="'+PAIRS[i].value+'">'+PAIRS[i].label+'</option>'; }
    sel.innerHTML = html;
    sel.value = defVal;
  }
  fillPairSelect(UI.in_pair, "ETH|ETH");
  fillPairSelect(UI.out_pair, "ETH|ETH");

  function toast(msg, ms){ UI.toast.textContent=msg; UI.toast.hidden=false; setTimeout(function(){ UI.toast.hidden=true; }, ms||3500); }
  function format(x, d){ if(x===null||x===undefined) x=0; return Number(x).toFixed(d||8); }
  function providerBadge(name){ var cls = (name==="Exolix"?"green":"blue"); return '<span class="badge '+cls+'">'+name+'</span>'; }

  function routeCard(o, isBest, index){
    var feeX = format(o.fee.our_fee_xmr, 6);
    var receive = format(o.receive_out, 8) + " " + last.request.out_asset;
    return '' +
    '<div class="route '+(isBest?'best':'')+'">' +
      '<div class="badges">' +
        providerBadge(o.leg1.provider) + ' <span class="badge">→</span> ' + providerBadge(o.leg2.provider) +
        (isBest?'<span class="badge blue">Best</span>':'') +
      '</div>' +
      '<div class="rows">' +
        '<div class="row"><span class="k">Leg 1</span><span class="v">'+format(o.leg1.amount_from,6)+' '+last.request.in_asset+' → '+format(o.leg1.amount_to,6)+' XMR</span></div>' +
        '<div class="row"><span class="k">Leg 2 (est.)</span><span class="v">'+format(o.leg2.amount_to,8)+' '+last.request.out_asset+'</span></div>' +
        '<div class="row"><span class="k">Our fee</span><span class="v">'+feeX+' XMR</span></div>' +
        '<div class="row"><span class="k"><strong>Receive (est.)</strong></span><span class="v"><strong>'+receive+'</strong></span></div>' +
      '</div>' +
      '<div class="actions" style="margin-top:8px">' +
        '<button data-i="'+index+'" class="choose">'+(isBest?'Choose':'Use this route')+'</button>' +
      '</div>' +
    '</div>';
  }

  function api(path, body){
    return fetch(path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)})
      .then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t); }); return r.json(); });
  }
  function apiGet(path){
    return fetch(path).then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t); }); return r.json(); });
  }

  var form = $("#quoteForm");
  if (form){
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var inPair  = UI.in_pair.value.split("|");
      var outPair = UI.out_pair.value.split("|");
      var req = {
        in_asset: inPair[0], in_network: inPair[1],
        out_asset: outPair[0], out_network: outPair[1],
        amount: parseFloat(UI.amount.value), rate_type: UI.rate.value
      };
      if(!req.amount || req.amount <= 0){ toast("Enter a valid amount."); return; }

      UI.btnQuote.disabled = true;
      api("/api/quote", req).then(function(data){
        last.request = data.request;
        last.options = data.options || [];
        last.best_index = data.best_index;
        last.chosen = null;

        if(!last.options.length){ UI.routesWrap.hidden=true; toast("No routes available."); return; }

        var best = last.options[(last.best_index>=0?last.best_index:0)];
        UI.bestRoute.innerHTML = routeCard(best, true, (last.best_index>=0?last.best_index:0));

        var othersHtml = "";
        for (var i=0;i<last.options.length;i++){
          if (i === last.best_index) continue;
          othersHtml += routeCard(last.options[i], false, i);
        }
        UI.otherRoutes.innerHTML = othersHtml;

        var count = last.options.length - 1;
        UI.toggleOthers.hidden = count <= 0;
        UI.toggleOthers.textContent = count>0 ? ("Show other routes ("+count+")") : "Show other routes";
        UI.toggleOthers.setAttribute("aria-expanded","false");
        UI.otherRoutes.hidden = true;
        UI.routesWrap.hidden = false;

        var bestBtn = UI.bestRoute.querySelector(".choose");
        if (bestBtn) bestBtn.addEventListener("click", function(){ chooseRoute((last.best_index>=0?last.best_index:0)); });
        var btns = UI.otherRoutes.querySelectorAll(".choose");
        for (var j=0;j<btns.length;j++){
          (function(k){ btns[k].addEventListener("click", function(){ chooseRoute(parseInt(btns[k].getAttribute("data-i"),10)); }); })(j);
        }

        UI.toggleOthers.onclick = function(){
          var v = UI.otherRoutes.hidden;
          UI.otherRoutes.hidden = !v;
          UI.toggleOthers.textContent = v ? ("Hide other routes ("+count+")") : ("Show other routes ("+count+")");
          UI.toggleOthers.setAttribute("aria-expanded", v ? "true":"false");
        };

        toast("Quoted successfully.");
      }).catch(function(err){
        console.error(err); toast("Quote error: " + err.message);
      }).finally(function(){ UI.btnQuote.disabled = false; });
    });
  }

  function chooseRoute(i){
    var o = last.options[i]; if(!o) return;
    last.chosen = o;
    UI.leg1.value = o.leg1.provider;
    UI.leg2.value = "Auto (best at send)";  // <— auto-pick at send time
    UI.btnStart.disabled = false;
    toast("Route selected: " + o.leg1.provider + " → Auto");
  }

  if (UI.btnStart){
    UI.btnStart.addEventListener("click", function(){
      if(!last.chosen){ toast("Choose a route first."); return; }
      var addr = UI.payout.value.trim();
      if(!addr){ toast("Enter your payout address."); return; }

      var inPair  = UI.in_pair.value.split("|");
      var outPair = UI.out_pair.value.split("|");
      var body = {
        leg1_provider: last.chosen.leg1.provider,
        leg2_mode: "auto",                              // <— tell backend to auto-pick for leg-2
        in_asset: inPair[0], in_network: inPair[1],
        out_asset: outPair[0], out_network: outPair[1],
        amount: last.request.amount, payout_address: addr, rate_type: last.request.rate_type,
        our_fee_xmr: last.chosen.fee.our_fee_xmr
      };
      UI.btnStart.disabled = true;
      api("/api/start", body).then(function(d){
        UI.swap.value = d.swap_id;
        UI.sr.hidden = false;
        UI.sr_id.textContent = d.swap_id;
        UI.sr_dep.textContent = d.deposit_address;
        if (d.deposit_extra){ UI.sr_extra_row.hidden=false; UI.sr_extra.textContent=d.deposit_extra; } else { UI.sr_extra_row.hidden=true; }
        if (navigator.clipboard){
          UI.btnCopy.onclick = function(){ navigator.clipboard.writeText(d.deposit_address).then(function(){ toast("Pay-in address copied."); }); };
        }
        toast("Swap created. Send the deposit for Leg 1.");
      }).catch(function(err){
        console.error(err); toast("Start error: " + err.message);
      }).finally(function(){ UI.btnStart.disabled = false; });
    });
  }

  function iconFor(state){
    if (state === "done")   return '<div class="icon done">✓</div>';
    if (state === "active") return '<div class="icon spin">⟳</div>';
    return '<div class="icon todo">•</div>';
  }
  function step(label, state){
    return '<div class="step '+state+'">'+iconFor(state)+'<div class="label">'+label+'</div></div>';
  }
  function buildSteps(d){
    function has(k){ return (d.steps||[]).indexOf(k) !== -1; }
    var complete   = d.status === "complete";
    var leg1Done   = has("leg1_complete") || d.status === "leg1_complete" || complete;
    var leg1Proc   = has("leg1_processing") && !leg1Done;
    var awaiting   = has("waiting_deposit") && !leg1Proc && !leg1Done;
    var leg2Sent   = has("leg2_sent");            // <— only true after actual transfer
    var leg2Proc   = has("leg2_processing") && !complete;

    function st(done, active){ return done ? "done" : (active ? "active" : "todo"); }
    return '' +
      '<div class="steps">' +
        step("Receiving deposit", st(!awaiting, awaiting)) +
        step("Routing (leg 1)",   st(leg1Done, leg1Proc)) +
        step("Leg 1 done",        st(leg1Done, (!leg1Done && leg1Proc))) +
        step("Sending XMR",       st(leg2Sent, (!leg2Sent && leg1Done && !leg2Proc && !complete))) +
        step("Exchanging (leg 2)",st(leg2Proc || complete, (!complete && leg2Proc))) +
        step("Complete",          st(complete, false)) +
      '</div>';
  }

  function renderStatus(id){
    return apiGet("/api/status/" + id).then(function(d){
      UI.statusPanel.hidden = false;
      UI.statusPanel.innerHTML = buildSteps(d) +
        '<div class="rows" style="margin-top:12px">' +
          '<div class="row"><span class="k">Leg1</span><span class="v">'+((d.leg1&&d.leg1.tx_id)||"—")+' | deposit: '+((d.leg1&&d.leg1.deposit)||"—")+'</span></div>' +
          '<div class="row"><span class="k">Leg2</span><span class="v">'+((d.leg2&&d.leg2.tx_id)||"—")+' | deposit: '+((d.leg2&&d.leg2.deposit)||"—")+'</span></div>' +
        '</div>';

      // Accounting tags: show "to forward" until leg2_sent exists
      var recv = format(d.accounting && d.accounting.xmr_received);
      var fee  = format(d.accounting && d.accounting.our_fee_xmr);
      var toFwdVal = Math.max(0, (d.accounting && d.accounting.xmr_received || 0) - (d.accounting && d.accounting.our_fee_xmr || 0));
      var toFwd = format(toFwdVal);
      var fwd   = format(d.accounting && d.accounting.xmr_forwarded);
      var tags = '<span class="tag">XMR received: '+recv+'</span>' +
                 '<span class="tag">Our fee: '+fee+'</span>';
      if ((d.steps||[]).indexOf("leg2_sent") !== -1) {
        tags += '<span class="tag">XMR forwarded: '+fwd+'</span>';
      } else {
        tags += '<span class="tag">XMR to forward: '+toFwd+'</span>';
      }
      UI.accounting.hidden = false;
      UI.accounting.innerHTML = tags;

      return d;
    });
  }

  if (UI.btnStatus){
    UI.btnStatus.addEventListener("click", function(){
      var id = UI.swap.value.trim(); if(!id){ toast("Enter or start a swap first."); return; }
      renderStatus(id).catch(function(err){ console.error(err); toast("Status error: " + err.message); });
    });
  }
  if (UI.btnWatch){
    UI.btnWatch.addEventListener("click", function(){
      var id = UI.swap.value.trim(); if(!id){ toast("Enter or start a swap first."); return; }
      if (last.watcher){ clearInterval(last.watcher); }
      UI.btnStop.disabled = false;
      last.watcher = setInterval(function(){
        renderStatus(id).then(function(d){
          if (d.status==="complete"){ clearInterval(last.watcher); last.watcher=null; UI.btnStop.disabled=true; toast("Swap complete."); }
        })["catch"](function(){});
      }, 8000);
      toast("Watching…");
    });
  }
  if (UI.btnStop){
    UI.btnStop.addEventListener("click", function(){
      if (last.watcher){ clearInterval(last.watcher); last.watcher=null; UI.btnStop.disabled=true; toast("Stopped."); }
    });
  }
})();
