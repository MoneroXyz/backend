# app.py
import os, time, uuid, httpx, math, asyncio, contextlib
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, Literal, Dict, List
from dotenv import load_dotenv

load_dotenv()

# ================== ENV ==================
CN_KEY   = os.getenv("CHANGENOW_API_KEY", "").strip()

_EX_KEY  = os.getenv("EXOLIX_API_KEY", "").strip()
EX_AUTH  = _EX_KEY if _EX_KEY.lower().startswith("bearer ") else (f"Bearer {_EX_KEY}" if _EX_KEY else "")

# Kept for backward compatibility / manual testing, but not used for new swaps now that we create per-swap subaddresses
XMR_ADDR = os.getenv("XMR_OUR_RECEIVE_ADDRESS", "").strip()

WALLET_URL = os.getenv("XMR_WALLET_RPC_URL", "http://127.0.0.1:18083/json_rpc").strip()
W_USER     = os.getenv("XMR_WALLET_RPC_USER", "").strip()
W_PASS     = os.getenv("XMR_WALLET_RPC_PASS", "").strip()

# Fees / reserves
FEE_CAP_RATIO    = float(os.getenv("OUR_FEE_MAX_RATIO", "0.15"))       # 15% cap during quoting
SEND_FEE_RESERVE = float(os.getenv("XMR_SEND_FEE_RESERVE", "0.00030")) # keep a tiny XMR for miner fee

# Sweeper cadence (seconds)
SWEEP_INTERVAL_S = float(os.getenv("SWEEP_INTERVAL_S", "8"))

# ================== APP ==================
app = FastAPI(title="Monerizer MVP", version="0.4.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/ui", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="ui")

# in-memory store (+ lock)
SWAPS: Dict[str, Dict] = {}
SWAPS_LOCK = asyncio.Lock()

# ================== MODELS ==================
class QuoteRequest(BaseModel):
    in_asset: Literal["BTC","ETH","USDT","USDC","LTC"]
    in_network: Literal["BTC","ETH","TRX","BSC","LTC"]
    out_asset: Literal["BTC","ETH","USDT","USDC","LTC"]
    out_network: Literal["BTC","ETH","TRX","BSC","LTC"]
    amount: float
    rate_type: Literal["float","fixed"] = "float"

class LegQuote(BaseModel):
    provider: str
    amount_from: float
    amount_to: float

class FeeBreakdown(BaseModel):
    provider_spread_xmr: float
    our_fee_xmr: float
    policy: str

class RouteOption(BaseModel):
    leg1: LegQuote
    leg2: LegQuote
    fee: FeeBreakdown
    receive_out: float

class QuoteResponse(BaseModel):
    request: QuoteRequest
    options: List[RouteOption]
    best_index: int

class StartSwapRequest(BaseModel):
    # NOTE: made leg2_provider optional (defaults to Exolix) to avoid 422 if UI forgets it
    leg1_provider: Literal["ChangeNOW","Exolix"]
    leg2_provider: Optional[Literal["ChangeNOW","Exolix"]] = None

    in_asset: str
    in_network: str
    out_asset: str
    out_network: str
    amount: float
    payout_address: str
    rate_type: Literal["float","fixed"] = "float"
    our_fee_xmr: Optional[float] = 0.0

class StartSwapResponse(BaseModel):
    swap_id: str
    deposit_address: str
    deposit_extra: Optional[str] = None
    leg1_tx_id: str
    status: str

# ================== HELPERS ==================
async def coingecko_prices() -> Dict[str,float]:
    ids = {"BTC":"bitcoin","ETH":"ethereum","USDT":"tether","USDC":"usd-coin","LTC":"litecoin","XMR":"monero"}
    url = "https://api.coingecko.com/api/v3/simple/price"
    out: Dict[str, float] = {}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(url, params={"ids": ",".join(ids.values()), "vs_currencies":"usd"})
            r.raise_for_status()
            data = r.json()
        for k, v in ids.items():
            out[k] = float(data.get(v, {}).get("usd", 0) or 0)
    except Exception:
        pass
    defaults = {"BTC":60000,"ETH":3000,"USDT":1.0,"USDC":1.0,"LTC":70,"XMR":160}
    for k, v in defaults.items():
        out.setdefault(k, v)
    return out

def _cn_headers():
    h = {"Accept":"application/json","Content-Type":"application/json"}
    if CN_KEY:
        h["x-changenow-api-key"] = CN_KEY
    return h

def _ex_headers():
    h = {"Accept":"application/json","Content-Type":"application/json"}
    if EX_AUTH:
        h["Authorization"] = EX_AUTH
    return h

# -------- ChangeNOW (estimate; robust; only /exchange/estimated-amount) --------
async def cn_estimate(frm: str, to: str, amt: float,
                      frm_net: Optional[str] = None, to_net: Optional[str] = None,
                      flow: str = "standard"):
    h = _cn_headers()
    if frm.lower() == "xmr": frm_net = None
    if to.lower()  == "xmr": to_net  = None

    async def _estimated(amount: float, fnet, tnet):
        params = {"fromCurrency": frm.lower(),
                  "toCurrency":   to.lower(),
                  "fromAmount":   str(amount),
                  "flow":         flow}
        if fnet: params["fromNetwork"] = fnet.lower()
        if tnet: params["toNetwork"]   = tnet.lower()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://api.changenow.io/v2/exchange/estimated-amount",
                            params=params, headers=h)
            if r.status_code == 200:
                j = r.json()
                v = j.get("toAmount")
                if v in (None, "", 0, "0"): v = j.get("estimatedAmount")
                try:
                    n = float(v) if v not in (None, "") else 0.0
                except Exception:
                    n = 0.0
                if n > 0:
                    j["toAmount"] = n
                    return j
            return {"toAmount": 0.0, "_status": r.status_code, "_text": (r.text or "")}

    j = await _estimated(amt, None, None)
    if j.get("toAmount", 0.0) > 0: return j

    j2 = await _estimated(amt, frm_net, to_net)
    if j2.get("toAmount", 0.0) > 0: return j2

    j3 = await _estimated(max(1e-12, amt * 0.999), frm_net, to_net)
    if j3.get("toAmount", 0.0) > 0: return j3

    return {"toAmount": 0.0}

async def cn_create(frm: str, to: str, amt: float, payout_address: str,
                    frm_net: Optional[str] = None, to_net: Optional[str] = None,
                    flow: str = "standard", refund_address: Optional[str] = None):
    h = _cn_headers()
    if frm.lower() == "xmr": frm_net = None
    if to.lower()  == "xmr": to_net  = None
    body = {"fromCurrency": frm, "toCurrency": to, "fromAmount": str(amt), "address": payout_address, "flow": flow}
    if frm_net: body["fromNetwork"] = frm_net.lower()
    if to_net:  body["toNetwork"]   = to_net.lower()
    if refund_address: body["refundAddress"] = refund_address
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post("https://api.changenow.io/v2/exchange", json=body, headers=h)
        r.raise_for_status()
        return r.json()

async def cn_info(tx_id: str):
    h = _cn_headers()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://api.changenow.io/v2/exchange/by-id", params={"id": tx_id}, headers=h)
        r.raise_for_status()
        return r.json()

# -------- Exolix --------
async def ex_rate(frm: str, net_from: Optional[str], to: str, net_to: Optional[str], amt: float, rate_type: str = "float"):
    p = {"coinFrom": frm, "coinTo": to, "amount": str(amt), "rateType": rate_type}
    if net_from: p["networkFrom"] = net_from
    if net_to:   p["networkTo"]   = net_to
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://exolix.com/api/v2/rate", params=p, headers=_ex_headers())
        if r.status_code == 200:
            j = r.json()
            if float(j.get("toAmount") or 0) > 0:
                return j
        # fallback without nets (let Exolix infer)
        p2 = {"coinFrom": frm, "coinTo": to, "amount": str(amt), "rateType": rate_type}
        r2 = await c.get("https://exolix.com/api/v2/rate", params=p2, headers=_ex_headers())
        return r2.json() if r2.status_code == 200 else {"toAmount": 0.0, "fromAmount": amt}

async def ex_create(frm: str, net_from: Optional[str], to: str, net_to: Optional[str], amt: float, withdrawal: str, rate_type: str = "float"):
    b = {"coinFrom": frm, "coinTo": to, "networkFrom": net_from, "networkTo": net_to, "amount": amt, "withdrawalAddress": withdrawal, "rateType": rate_type}
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post("https://exolix.com/api/v2/transactions", json=b, headers=_ex_headers())
        r.raise_for_status()
        return r.json()

async def ex_info(tx_id: str):
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"https://exolix.com/api/v2/transactions/{tx_id}", headers=_ex_headers())
        r.raise_for_status()
        return r.json()

# -------- Wallet RPC --------
async def wallet_rpc(method: str, params: dict) -> dict:
    auth = (W_USER, W_PASS) if (W_USER or W_PASS) else None
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post(WALLET_URL, json={"jsonrpc":"2.0","id":"0","method":method,"params":params}, auth=auth)
        r.raise_for_status()
        j = r.json()
        if "error" in j:
            raise HTTPException(502, str(j["error"]))
        return j["result"]

def xmr_to_atomic(x: float) -> int:
    return int(round(float(x) * 1_000_000_000_000))

async def get_unlocked_balance() -> float:
    try:
        res = await wallet_rpc("get_balance", {"account_index": 0})
        return float(res.get("unlocked_balance", 0)) / 1e12
    except Exception:
        return 0.0

# ---- NEW: subaddress + incoming detection ----
async def create_subaddress(label: str) -> Dict[str, str]:
    res = await wallet_rpc("create_address", {"account_index": 0, "label": label})
    # typical fields: address, address_index
    return {"address": res.get("address", ""), "address_index": int(res.get("address_index", 0))}

async def sum_received_for_subaddr(address_index: int) -> float:
    """
    Sum unique incoming amounts (confirmed, pending, pool) to this subaddress.
    Used to mark leg-1 complete as soon as funds are seen.
    """
    try:
        params = {"account_index": 0, "in": True, "pending": True, "pool": True, "subaddr_indices": [int(address_index)]}
        res = await wallet_rpc("get_transfers", params)
        seen = set()
        total_xmr = 0.0
        for bucket in ("in", "pending", "pool"):
            for t in res.get(bucket, []) or []:
                txid = t.get("txid") or t.get("tx_hash")
                if txid and txid in seen:
                    continue
                seen.add(txid)
                total_xmr += float(t.get("amount", 0)) / 1e12
        return total_xmr
    except Exception:
        return 0.0

# ================== QUOTE ==================
@app.post("/api/quote", response_model=QuoteResponse)
async def quote(req: QuoteRequest):
    if not XMR_ADDR:
        # Not strictly required anymore, but keep validation to catch missing envs on old paths
        pass

    # Leg-1 (in -> XMR)
    l1_ex = await ex_rate(req.in_asset, req.in_network, "XMR", "XMR", req.amount, req.rate_type)
    l1_cn = await cn_estimate(req.in_asset.lower(), "xmr", req.amount, req.in_network.lower(), "xmr")

    q1: List[LegQuote] = []
    ex1 = float(l1_ex.get("toAmount") or 0.0)
    cn1 = float(l1_cn.get("toAmount") or l1_cn.get("estimatedAmount") or 0.0)
    if ex1 > 0: q1.append(LegQuote(provider="Exolix",    amount_from=float(l1_ex.get("fromAmount", req.amount)), amount_to=ex1))
    if cn1 > 0: q1.append(LegQuote(provider="ChangeNOW", amount_from=req.amount, amount_to=cn1))

    xmr_budget = max((q.amount_to for q in q1), default=0.0)
    if xmr_budget <= 0:
        raise HTTPException(502, "Providers did not return leg-1 quotes")

    # Leg-2 (XMR -> out), priced at the best L1 XMR budget
    l2_ex = await ex_rate("XMR", "XMR", req.out_asset, req.out_network, xmr_budget, req.rate_type)
    l2_cn = await cn_estimate("xmr", req.out_asset.lower(), xmr_budget, "xmr", req.out_network.lower())

    q2: List[LegQuote] = []
    ex2 = float(l2_ex.get("toAmount") or 0.0)
    cn2 = float(l2_cn.get("toAmount") or 0.0) or float(l2_cn.get("estimatedAmount") or 0.0)
    if ex2 > 0: q2.append(LegQuote(provider="Exolix",    amount_from=xmr_budget, amount_to=ex2))
    if cn2 > 0: q2.append(LegQuote(provider="ChangeNOW", amount_from=xmr_budget, amount_to=cn2))

    px = await coingecko_prices()
    options: List[RouteOption] = []
    for a in q1:
        for b in q2:
            if a.amount_to <= 0 or b.amount_to <= 0:
                continue

            scale = a.amount_to / xmr_budget if xmr_budget else 1.0
            b_out = b.amount_to * scale

            theo_xmr_l1   = req.amount * px[req.in_asset] / px["XMR"]
            spread_l1     = max(0.0, theo_xmr_l1 - a.amount_to)
            out_xmr_equiv = b_out * px[req.out_asset] / px["XMR"]
            spread_l2     = max(0.0, a.amount_to - out_xmr_equiv)
            prov_spread   = spread_l1 + spread_l2

            fee_cap = a.amount_to * FEE_CAP_RATIO
            our_fee = min(max(0.0, prov_spread), fee_cap)

            xmr_fwd   = max(0.0, a.amount_to - our_fee)
            out_after = b_out * (xmr_fwd / a.amount_to) if a.amount_to > 0 else 0.0

            options.append(RouteOption(
                leg1=a,
                leg2=LegQuote(provider=b.provider, amount_from=a.amount_to, amount_to=out_after),
                fee=FeeBreakdown(provider_spread_xmr=prov_spread, our_fee_xmr=our_fee, policy="mirror_provider_spread_capped"),
                receive_out=out_after
            ))

    if not options:
        raise HTTPException(502, "No viable routes")

    options.sort(key=lambda o: o.receive_out, reverse=True)
    return QuoteResponse(request=req, options=options, best_index=0)

# ================== DEBUG (optional) ==================
@app.post("/api/quote_debug")
async def quote_debug(req: QuoteRequest):
    l1_ex = await ex_rate(req.in_asset, req.in_network, "XMR", "XMR", req.amount, req.rate_type)
    l1_cn = await cn_estimate(req.in_asset.lower(), "xmr", req.amount, req.in_network.lower(), "xmr")
    xmr_budget = float(max(
        float(l1_ex.get("toAmount") or 0),
        float(l1_cn.get("toAmount") or l1_cn.get("estimatedAmount") or 0)
    ))
    l2_ex = {}
    l2_cn = {}
    if xmr_budget > 0:
        l2_ex = await ex_rate("XMR", "XMR", req.out_asset, req.out_network, xmr_budget, req.rate_type)
        l2_cn = await cn_estimate("xmr", req.out_asset.lower(), xmr_budget, "xmr", req.out_network.lower())
    return {"request": req.model_dump(), "leg1_ex": l1_ex, "leg1_cn": l1_cn, "xmr_budget": xmr_budget, "leg2_ex": l2_ex, "leg2_cn": l2_cn}

@app.post("/api/cn_probe")
async def cn_probe(req: QuoteRequest):
    h = _cn_headers()
    fnet = req.in_network if req.in_asset.upper() != "XMR" else None
    tnet = req.out_network if req.out_asset.upper() != "XMR" else None
    async def call(url: str, params: dict):
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(url, params=params, headers=h)
                txt = r.text or ""
                return {"status": r.status_code, "ok": r.status_code == 200, "url": url, "params": params, "body_head": txt[:400]}
        except Exception as e:
            return {"status": -1, "ok": False, "error": str(e), "url": url, "params": params}
    markets_with = {"fromCurrency": req.in_asset.lower(), "toCurrency": req.out_asset.lower(), "fromAmount": str(req.amount), "type": "direct"}
    est_with     = {"fromCurrency": req.in_asset.lower(), "toCurrency": req.out_asset.lower(), "fromAmount": str(req.amount), "flow": "standard"}
    if fnet: markets_with["fromNetwork"] = fnet.lower(); est_with["fromNetwork"] = fnet.lower()
    if tnet: markets_with["toNetwork"]   = tnet.lower(); est_with["toNetwork"]   = tnet.lower()
    markets_wo = {k:v for k,v in markets_with.items() if k not in ("fromNetwork","toNetwork")}
    est_wo     = {k:v for k,v in est_with.items()     if k not in ("fromNetwork","toNetwork")}
    m_with = await call("https://api.changenow.io/v2/markets/estimate",          markets_with)
    e_with = await call("https://api.changenow.io/v2/exchange/estimated-amount", est_with)
    m_wo   = await call("https://api.changenow.io/v2/markets/estimate",          markets_wo)
    e_wo   = await call("https://api.changenow.io/v2/exchange/estimated-amount", est_wo)
    return {"probe": {"markets_with": m_with, "estimated_with": e_with, "markets_without": m_wo, "estimated_without": e_wo}}

# ================== START SWAP ==================
@app.post("/api/start", response_model=StartSwapResponse)
async def start(req: StartSwapRequest):
    # Create a unique swap id first (needed for the subaddress label)
    sid = str(uuid.uuid4())

    # Create a dedicated subaddress for this swap (account 0)
    recv = await create_subaddress(label=f"swap:{sid}")

    # Create leg-1 order (payout to our per-swap XMR subaddress)
    leg2_provider = req.leg2_provider or "Exolix"
    if req.leg1_provider == "Exolix":
        tx1 = await ex_create(req.in_asset, req.in_network, "XMR", "XMR", req.amount, recv["address"], req.rate_type)
        deposit = tx1.get("depositAddress", "")
        extra   = tx1.get("depositExtraId")
        txid    = tx1.get("id", "")
    else:
        tx1 = await cn_create(req.in_asset.lower(), "xmr", req.amount, recv["address"], req.in_network.lower(), "xmr")
        deposit = tx1.get("payinAddress") or tx1.get("depositAddress") or tx1.get("address") or ""
        extra   = tx1.get("payinExtraId") or tx1.get("payinTag")
        txid    = tx1.get("id") or tx1.get("transactionId") or ""

    if not deposit:
        raise HTTPException(502, "Provider didn't return deposit address")

    async with SWAPS_LOCK:
        SWAPS[sid] = {
            "created": time.time(),
            "status": "waiting_deposit",
            "req": {**req.model_dump(), "leg2_provider": leg2_provider},
            "our_fee_xmr": float(req.our_fee_xmr or 0.0),
            "recv": {"address": recv["address"], "address_index": int(recv["address_index"])},
            "leg1": {"tx_id": txid, "deposit": deposit, "extra": extra, "provider": req.leg1_provider},
            "leg2": {},
            "xmr_received": 0.0,     # running total observed to this swap's subaddress
            "xmr_forwarded": 0.0
        }

    return StartSwapResponse(swap_id=sid, deposit_address=deposit, deposit_extra=extra, leg1_tx_id=txid, status="waiting_deposit")

# ================== CORE PROCESSOR ==================
async def _process_swap_locked(sw: Dict, unlocked_hint: Optional[float] = None) -> List[str]:
    """
    Core state machine for a single swap. Requires caller to hold SWAPS_LOCK.
    Returns a list of step labels taken (for status endpoint).
    """
    steps: List[str] = ["waiting_deposit"]
    req = sw["req"]

    # --- NEW: wallet-based leg-1 confirmation via subaddress ---
    recv_info = sw.get("recv") or {}
    addr_index = recv_info.get("address_index")
    if addr_index is not None:
        try:
            seen_total = await sum_received_for_subaddr(int(addr_index))
            if seen_total > (sw.get("xmr_received") or 0.0):
                sw["xmr_received"] = seen_total
            if (sw.get("xmr_received", 0.0) > 0) and sw.get("status") in ("waiting_deposit", "leg1_processing", None):
                sw["status"] = "leg1_complete"
                if "leg1_complete" not in steps:
                    steps.append("leg1_complete")
        except Exception:
            pass

    # Provider poll is kept for observability, but no longer gates leg-2
    l1prov = sw["leg1"].get("provider")
    try:
        if l1prov == "Exolix":
            info = await ex_info(sw["leg1"]["tx_id"])
            s1 = str(info.get("status", ""))
            xmr_out = float(info.get("amountTo") or 0.0)
        else:
            info = await cn_info(sw["leg1"]["tx_id"])
            s1 = str(info.get("status") or info.get("state") or "")
            xmr_out = float(info.get("payoutAmount") or info.get("toAmount") or 0.0)
        # If provider reports a positive amount, keep the max
        if xmr_out > 0:
            sw["xmr_received"] = max(sw.get("xmr_received", 0.0), xmr_out)
        # If provider says finished, reflect that status (but wallet already handled it above)
        if s1.lower() in ("success","finished","complete","completed","done"):
            sw["status"] = "leg1_complete"
            if "leg1_complete" not in steps:
                steps.append("leg1_complete")
        else:
            # If we haven't seen funds yet and provider still processing, keep processing
            if sw.get("xmr_received", 0.0) <= 0:
                sw["status"] = "leg1_processing"
                steps.append("leg1_processing")
                return steps
    except Exception:
        # If provider poll fails, we still proceed if wallet saw funds
        if sw.get("xmr_received", 0.0) <= 0:
            sw["status"] = "leg1_processing"
            steps.append("leg1_processing")
            return steps

    # 2) If leg-1 done (by wallet or provider), create leg-2 when unlocked is enough; then send
    xmr_fwd_target = max(0.0, sw.get("xmr_received", 0.0) - float(sw.get("our_fee_xmr", 0.0)))
    if xmr_fwd_target <= 0:
        return steps

    unlocked = unlocked_hint if unlocked_hint is not None else await get_unlocked_balance()

    if not sw["leg2"].get("tx_id"):
        if unlocked + 1e-12 >= max(0.0, xmr_fwd_target + SEND_FEE_RESERVE):
            # create leg-2 with chosen provider (fixed at start)
            if req["leg2_provider"] == "Exolix":
                tx2 = await ex_create("XMR", "XMR", req["out_asset"], req["out_network"], xmr_fwd_target, req["payout_address"], req["rate_type"])
                sw["leg2"] = {"tx_id": tx2.get("id",""), "deposit": tx2.get("depositAddress",""), "provider": "Exolix"}
            else:
                tx2 = await cn_create("xmr", req["out_asset"].lower(), xmr_fwd_target, req["payout_address"], "xmr", req["out_network"].lower())
                sw["leg2"] = {"tx_id": tx2.get("id") or tx2.get("transactionId") or "", "deposit": tx2.get("payinAddress") or tx2.get("depositAddress") or "", "provider": "ChangeNOW"}

            dest = sw["leg2"].get("deposit")
            if dest:
                send_amount = max(0.0, min(xmr_fwd_target, unlocked - SEND_FEE_RESERVE))
                if send_amount > 0:
                    await wallet_rpc("transfer", {"destinations":[{"address": dest, "amount": xmr_to_atomic(send_amount)}], "priority": 2})
                    sw["xmr_forwarded"] = send_amount
                    sw["status"] = "leg2_sent"
                    steps.append("leg2_sent")
        else:
            sw["status"] = "waiting_unlock"
            steps.append("waiting_unlock")
            return steps

    # 3) If leg-2 exists, poll it
    if sw["leg2"].get("tx_id"):
        try:
            if sw["leg2"].get("provider") == "Exolix":
                info2 = await ex_info(sw["leg2"]["tx_id"])
                s2 = str(info2.get("status",""))
            else:
                info2 = await cn_info(sw["leg2"]["tx_id"])
                s2 = str(info2.get("status") or info2.get("state") or "")
            if s2.lower() in ("success","finished","complete","completed","done"):
                sw["status"] = "complete"
                steps.append("complete")
            else:
                steps.append("leg2_processing")
        except Exception:
            steps.append("leg2_processing")

    return steps

async def _process_swap(swap_id: str, unlocked_hint: Optional[float] = None) -> Dict:
    async with SWAPS_LOCK:
        sw = SWAPS.get(swap_id)
        if not sw:
            raise HTTPException(404, "swap not found")
        steps = await _process_swap_locked(sw, unlocked_hint)
        # Return API-shaped payload
        return {
            "swap_id": swap_id,
            "status": sw["status"],
            "steps": steps,
            "recv": sw.get("recv", {}),
            "leg1": sw["leg1"],
            "leg2": sw["leg2"],
            "accounting": {
                "xmr_received": sw.get("xmr_received", 0.0),
                "our_fee_xmr": sw.get("our_fee_xmr", 0.0),
                "xmr_forwarded": sw.get("xmr_forwarded", 0.0),
            }
        }

# ================== STATUS (uses core processor) ==================
@app.get("/api/status/{swap_id}")
async def status(swap_id: str):
    return await _process_swap(swap_id)

# ================== BACKGROUND SWEEPER ==================
async def sweeper_loop():
    await asyncio.sleep(1.0)  # tiny delay after startup
    while True:
        try:
            # compute unlocked once per sweep (one wallet)
            unlocked = await get_unlocked_balance()
            async with SWAPS_LOCK:
                ids = [k for k, v in SWAPS.items() if v.get("status") != "complete"]
            for sid in ids:
                try:
                    await _process_swap(sid, unlocked_hint=unlocked)
                except Exception:
                    # keep the loop alive if one swap fails
                    pass
        except Exception:
            pass
        await asyncio.sleep(SWEEP_INTERVAL_S)

@app.on_event("startup")
async def _on_startup():
    app.state.sweeper_task = asyncio.create_task(sweeper_loop())

@app.on_event("shutdown")
async def _on_shutdown():
    task: asyncio.Task = getattr(app.state, "sweeper_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(Exception):
            await task
