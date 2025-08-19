# app.py
import os, time, uuid, httpx, asyncio, contextlib, json
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, Literal, Dict, List
from dotenv import load_dotenv

# --- robust .env loading (handles Windows / different CWDs) ---
env_loaded = False
for candidate in [Path(__file__).with_name(".env"), Path.cwd() / ".env"]:
    if candidate.exists():
        load_dotenv(dotenv_path=candidate, override=False)
        env_loaded = True
if not env_loaded:
    load_dotenv()

# ================== ENV ==================
CN_KEY = os.getenv("CHANGENOW_API_KEY", "").strip()
_EX_KEY = os.getenv("EXOLIX_API_KEY", "").strip()
EX_AUTH = _EX_KEY if _EX_KEY.lower().startswith("bearer ") else (f"Bearer {_EX_KEY}" if _EX_KEY else "")
SS_KEY = os.getenv("SIMPLESWAP_API_KEY", "").strip()
XMR_ADDR = os.getenv("XMR_OUR_RECEIVE_ADDRESS", "").strip()  # legacy/manual tests
WALLET_URL = os.getenv("XMR_WALLET_RPC_URL", "http://127.0.0.1:18083/json_rpc").strip()
W_USER = os.getenv("XMR_WALLET_RPC_USER", "").strip()
W_PASS = os.getenv("XMR_WALLET_RPC_PASS", "").strip()
FEE_CAP_RATIO = float(os.getenv("OUR_FEE_MAX_RATIO", "0.15"))
SEND_FEE_RESERVE = float(os.getenv("XMR_SEND_FEE_RESERVE", "0.00030"))
SWEEP_INTERVAL_S = float(os.getenv("SWEEP_INTERVAL_S", "8"))

# ================== APP ==================
APP_VERSION = "0.4.7"
app = FastAPI(title="Monerizer MVP", version=APP_VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/ui", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="ui")
SWAPS: Dict[str, Dict] = {}
SWAPS_LOCK = asyncio.Lock()
_last_quote_req: Optional[dict] = None  # for diagnostics

# ====== Providers (moved out) ======
from providers import (
    cn_estimate, cn_create, cn_info,
    ex_rate, ex_create, ex_info,
    ss_estimate, ss_create, ss_info,
    _ss_map_net, _ss_params, SS_BASE,
    sx_estimate, sx_create, sx_info,  # [StealthEX] add imports
)

# ============== Persistence (very light JSON) ==============
STORAGE_PATH = os.path.join(os.path.dirname(__file__), "swaps.json")

def _load_swaps_from_disk() -> Dict[str, Dict]:
    try:
        if os.path.exists(STORAGE_PATH):
            with open(STORAGE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
    except Exception:
        pass
    return {}

def _save_swaps_to_disk():
    try:
        # (optional) collapse duplicate consecutive timeline entries for cleanliness
        for s in SWAPS.values():
            tl = s.get("timeline")
            if isinstance(tl, list) and tl:
                collapsed = []
                for e in tl:
                    if not collapsed or collapsed[-1] != e:
                        collapsed.append(e)
                s["timeline"] = collapsed

        tmp = STORAGE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(SWAPS, f, ensure_ascii=False, indent=2)
        os.replace(tmp, STORAGE_PATH)
    except Exception:
        pass

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
    leg1_provider: Literal["ChangeNOW","Exolix","SimpleSwap","StealthEX"]  # [StealthEX] added
    leg2_provider: Optional[Literal["ChangeNOW","Exolix","SimpleSwap","StealthEX"]] = None  # [StealthEX] added
    in_asset: str
    in_network: str
    out_asset: str
    out_network: str
    amount: float
    payout_address: str
    rate_type: Literal["float","fixed"] = "float"
    our_fee_xmr: Optional[float] = 0.0
    # ---- ADDED: customer-provided refund address for leg-1 ----
    refund_address_user: Optional[str] = None

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

# ================== QUOTE ==================
def _mirror_fee(provider_spread_xmr: float, leg1_xmr: float) -> float:
    return float(min(max(0.0, provider_spread_xmr), max(0.0, leg1_xmr) * FEE_CAP_RATIO))

async def _estimate_leg1_to_xmr(provider: str, req: QuoteRequest) -> Optional[float]:
    if provider == "ChangeNOW":
        j = await cn_estimate(req.in_asset, "XMR", req.amount, req.in_network, None,
                              "fixed" if req.rate_type=="fixed" else "standard")
        return float(j.get("toAmount", 0) or 0)
    if provider == "Exolix":
        j = await ex_rate(req.in_asset, req.in_network, "XMR", None, req.amount, req.rate_type)
        return float(j.get("toAmount", 0) or 0)
    if provider == "SimpleSwap":
        j = await ss_estimate(req.in_asset, "XMR", req.amount, req.in_network, None, req.rate_type)
        return float(j.get("toAmount", 0) or 0)
    if provider == "StealthEX":  # [StealthEX]
        j = await sx_estimate(req.in_asset, "XMR", req.amount, req.in_network, None, req.rate_type)
        return float(j.get("toAmount", 0) or 0)
    return 0.0

async def _estimate_leg2_from_xmr(provider: str, out_asset: str, out_network: str,
                                  xmr_in: float, rate_type: str) -> Optional[float]:
    if xmr_in <= 0: return 0.0
    if provider == "ChangeNOW":
        j = await cn_estimate("XMR", out_asset, xmr_in, None, out_network,
                              "fixed" if rate_type=="fixed" else "standard")
        return float(j.get("toAmount", 0) or 0)
    if provider == "Exolix":
        j = await ex_rate("XMR", None, out_asset, out_network, xmr_in, rate_type)
        return float(j.get("toAmount", 0) or 0)
    if provider == "SimpleSwap":
        j = await ss_estimate("XMR", out_asset, xmr_in, None, out_network, rate_type)
        return float(j.get("toAmount", 0) or 0)
    if provider == "StealthEX":  # [StealthEX]
        j = await sx_estimate("XMR", out_asset, xmr_in, None, out_network, rate_type)
        return float(j.get("toAmount", 0) or 0)
    return 0.0

@app.post("/api/quote", response_model=QuoteResponse)
async def api_quote(req: QuoteRequest):
    global _last_quote_req
    _last_quote_req = req.model_dump()  # for diagnostics
    providers = ["ChangeNOW", "Exolix", "SimpleSwap", "StealthEX"]  # [StealthEX] include in quotes

    leg1_results: Dict[str, float] = {}
    for p in providers:
        try:
            leg1_results[p] = await _estimate_leg1_to_xmr(p, req)
        except Exception:
            leg1_results[p] = 0.0

    prices = await coingecko_prices()
    usd_in = req.amount * prices.get(req.in_asset, 0)
    xmr_mid = prices.get("XMR", 0)

    options: List[RouteOption] = []
    for leg1_provider, leg1_xmr in leg1_results.items():
        if leg1_xmr <= 0: continue
        mid_xmr_expected = (usd_in / xmr_mid) if (usd_in > 0 and xmr_mid > 0) else 0.0
        provider_spread_xmr = max(0.0, mid_xmr_expected - leg1_xmr)
        our_fee = _mirror_fee(provider_spread_xmr, leg1_xmr)
        for leg2_provider in providers:
            if leg2_provider == leg1_provider:  # << enforce different providers in quotes
                continue
            try:
                leg2_out_amt = await _estimate_leg2_from_xmr(
                    leg2_provider, req.out_asset, req.out_network,
                    max(0.0, leg1_xmr - our_fee - SEND_FEE_RESERVE),
                    req.rate_type
                )
            except Exception:
                leg2_out_amt = 0.0
            if leg2_out_amt <= 0: continue
            options.append(RouteOption(
                leg1=LegQuote(provider=leg1_provider, amount_from=req.amount, amount_to=leg1_xmr),
                leg2=LegQuote(provider=leg2_provider, amount_from=max(0.0, leg1_xmr - our_fee - SEND_FEE_RESERVE), amount_to=leg2_out_amt),
                fee=FeeBreakdown(provider_spread_xmr=provider_spread_xmr, our_fee_xmr=our_fee, policy="mirror_provider_spread_capped"),
                receive_out=leg2_out_amt
            ))
    if not options:
        raise HTTPException(502, "All providers failed to quote.")
    options_sorted = sorted(options, key=lambda x: x.receive_out, reverse=True)
    return QuoteResponse(request=req, options=options_sorted, best_index=0)

# ================== START ==================
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

async def create_subaddress(label: str) -> Dict[str, str]:
    res = await wallet_rpc("create_address", {"account_index": 0, "label": label})
    return {"address": res.get("address", ""), "address_index": int(res.get("address_index", 0))}

async def sum_received_for_subaddr(address_index: int) -> float:
    total = 0.0
    seen = set()
    try:
        res = await wallet_rpc("get_transfers", {"in": True, "pool": True, "account_index": 0, "subaddr_indices": [address_index]})
        arr = []
        arr.extend(res.get("in", []))
        arr.extend(res.get("pool", []))
        for t in arr:
            key = (t.get("txid"), t.get("amount"))
            if key in seen: continue
            seen.add(key)
            total += float(t.get("amount", 0))/1e12
    except Exception:
        pass
    return total

async def wallet_unlocked_balance() -> float:
    try:
        res = await wallet_rpc("get_balance", {"account_index": 0})
        return float(res.get("unlocked_balance", 0))/1e12
    except Exception:
        return 0.0

async def _create_leg1_order(provider: str, req: StartSwapRequest, xmr_subaddr: str, refund_address: Optional[str]) -> Dict:
    if provider == "ChangeNOW":
        return await cn_create(req.in_asset, "XMR", req.amount, xmr_subaddr, req.in_network, None, "fixed" if req.rate_type=="fixed" else "standard", refund_address)
    if provider == "Exolix":
        return await ex_create(req.in_asset, req.in_network, "XMR", "XMR", req.amount, xmr_subaddr, req.rate_type)
    if provider == "SimpleSwap":
        return await ss_create(req.in_asset, "XMR", req.amount, xmr_subaddr, req.in_network, None, req.rate_type, refund_address)
    if provider == "StealthEX":  # [StealthEX]
        return await sx_create(req.in_asset, "XMR", req.amount, xmr_subaddr, req.in_network, None, req.rate_type, refund_address)
    raise HTTPException(400, f"Unsupported leg1 provider: {provider}")

# ---- CHANGED: allow passing a refund address to leg-2 providers ----
async def _create_leg2_order(provider: str, out_asset: str, out_network: str, amount_xmr: float, payout_address: str, rate_type: str, refund_address: Optional[str]) -> Dict:
    if provider == "ChangeNOW":
        return await cn_create("XMR", out_asset, amount_xmr, payout_address, None, out_network, "fixed" if rate_type=="fixed" else "standard", refund_address)
    if provider == "Exolix":
        return await ex_create("XMR", "XMR", out_asset, out_network, amount_xmr, payout_address, rate_type)
    if provider == "SimpleSwap":
        return await ss_create("XMR", out_asset, amount_xmr, payout_address, None, out_network, rate_type, refund_address)
    if provider == "StealthEX":  # [StealthEX]
        return await sx_create("XMR", out_asset, amount_xmr, payout_address, None, out_network, rate_type, refund_address)
    raise HTTPException(400, f"Unsupported leg2 provider: {provider}")

@app.post("/api/start", response_model=StartSwapResponse)
async def api_start(req: StartSwapRequest):
    # If leg2 is not specified, pick a different provider than leg1
    if not req.leg2_provider:
        for p in ["ChangeNOW", "Exolix", "SimpleSwap", "StealthEX"]:
            if p != req.leg1_provider:
                req.leg2_provider = p
                break

    # Hard rule: leg1 and leg2 must be different
    if req.leg1_provider == req.leg2_provider:
        raise HTTPException(400, "leg2_provider must differ from leg1_provider")

    swap_id = str(uuid.uuid4())

    sub = await create_subaddress(f"swap:{swap_id}")
    subaddr = sub["address"]
    subidx = sub["address_index"]

    # ---- pass customer refund (if any) to leg-1 provider ----
    refund_addr = req.refund_address_user or None
    leg1 = await _create_leg1_order(req.leg1_provider, req, subaddr, refund_addr)

    deposit_address = ""
    deposit_extra = None
    leg1_tx_id = ""
    if req.leg1_provider == "ChangeNOW":
        deposit_address = leg1.get("payinAddress") or leg1.get("payinAddressString") or ""
        deposit_extra = leg1.get("payinExtraId") or None
        leg1_tx_id = leg1.get("id") or leg1.get("exchangeId") or ""
    elif req.leg1_provider == "Exolix":
        deposit_address = leg1.get("depositAddress") or ""
        deposit_extra = leg1.get("depositExtraId") or None
        leg1_tx_id = leg1.get("id") or leg1.get("transaction_id") or ""
    elif req.leg1_provider == "SimpleSwap":
        deposit_address = leg1.get("deposit") or ""
        deposit_extra = leg1.get("extra_id") or None
        leg1_tx_id = leg1.get("id") or ""
    elif req.leg1_provider == "StealthEX":  # [StealthEX] normalize fields
        deposit_address = leg1.get("depositAddress") or ""
        deposit_extra = leg1.get("depositExtraId") or None
        leg1_tx_id = leg1.get("id") or ""

    async with SWAPS_LOCK:
        SWAPS[swap_id] = {
            "id": swap_id,
            "created": time.time(),
            "req": req.model_dump(),
            "user_refund_address": req.refund_address_user or None,  # store for admin view
            "subaddr_index": subidx,
            "subaddr": subaddr,
            "our_fee_xmr": float(req.our_fee_xmr or 0.0),
            "leg1": {
                "provider": req.leg1_provider,
                "order": leg1,
                "tx_id": leg1_tx_id,
                "deposit_address": deposit_address,
                "deposit_extra": deposit_extra,
                "status": "waiting_deposit"
            },
            "leg2": {
                "provider": req.leg2_provider,
                "created": False,
                "creating": False,
                "order": None,
                "tx_id": "",
                "status": "pending"
            },
            "timeline": ["created", "waiting_deposit"],
            "last_sent_txid": None,
        }
    _save_swaps_to_disk()

    return StartSwapResponse(
        swap_id=swap_id,
        deposit_address=deposit_address,
        deposit_extra=deposit_extra,
        leg1_tx_id=leg1_tx_id,
        status="waiting_deposit"
    )

# ================== STATUS / SWEEPER ==================

# ---- helpers to detect "refunded" in provider info ----
def _status_text(pinfo: Dict) -> str:
    if not isinstance(pinfo, dict):
        return ""
    return str(pinfo.get("status") or pinfo.get("state") or pinfo.get("stage") or "").lower()

def _looks_refunded(pinfo: Dict) -> bool:
    st = _status_text(pinfo)
    return any(k in st for k in ["refunded", "refund", "returned", "sent back", "reimbursed"])

async def _provider_info(provider: str, tx_id: str) -> Dict:
    if provider == "ChangeNOW": return await cn_info(tx_id)
    if provider == "Exolix": return await ex_info(tx_id)
    if provider == "SimpleSwap": return await ss_info(tx_id)
    if provider == "StealthEX": return await sx_info(tx_id)  # [StealthEX]
    return {}

async def _send_from_wallet_to(provider_deposit_addr: str, amount_xmr: float) -> str:
    try:
        res = await wallet_rpc("transfer", {
            "account_index": 0,
            "destinations": [{"amount": xmr_to_atomic(amount_xmr), "address": provider_deposit_addr}],
            "priority": 2,
            "ring_size": 11,
            "get_tx_key": True
        })
        return res.get("tx_hash", "")
    except Exception as e:
        raise HTTPException(502, f"Wallet send error: {e}")

async def _maybe_create_leg2_and_send(swap: Dict):
    # guard against duplicate creations
    if swap["leg2"].get("created") or swap["leg2"].get("creating"): return

    subidx = swap["subaddr_index"]
    rx_total = await sum_received_for_subaddr(subidx)  # pool+in (mempool+confirmed)
    need = max(0.0, (rx_total - float(swap.get("our_fee_xmr", 0.0)) - SEND_FEE_RESERVE))
    if need <= 0:
        return

    # Wallet-wide unlocked allowance
    unlocked_total = await wallet_unlocked_balance()
    if unlocked_total < need:
        swap["leg2"]["status"] = "awaiting_wallet_unlock"
        return

    # mark creating to avoid races
    swap["leg2"]["creating"] = True
    try:
        req = swap["req"]
        leg2 = await _create_leg2_order(
            provider=swap["leg2"]["provider"],
            out_asset=req["out_asset"],
            out_network=req["out_network"],
            amount_xmr=need,
            payout_address=req["payout_address"],
            rate_type=req["rate_type"],
            refund_address=swap.get("subaddr")  # always our subaddress for leg-2 refunds
        )
        deposit_addr = ""
        if swap["leg2"]["provider"] == "ChangeNOW":
            deposit_addr = leg2.get("payinAddress") or leg2.get("payinAddressString") or ""
            swap["leg2"]["tx_id"] = leg2.get("id") or leg2.get("exchangeId") or ""
        elif swap["leg2"]["provider"] == "Exolix":
            deposit_addr = leg2.get("depositAddress") or ""
            swap["leg2"]["tx_id"] = leg2.get("id") or leg2.get("transaction_id") or ""
        elif swap["leg2"]["provider"] == "SimpleSwap":
            deposit_addr = leg2.get("deposit") or ""
            swap["leg2"]["tx_id"] = leg2.get("id") or ""
        elif swap["leg2"]["provider"] == "StealthEX":  # [StealthEX]
            deposit_addr = leg2.get("depositAddress") or ""
            swap["leg2"]["tx_id"] = leg2.get("id") or ""

        if not deposit_addr:
            swap["leg2"]["creating"] = False
            raise HTTPException(502, "Leg-2 provider did not return a deposit address")

        tx_hash = await _send_from_wallet_to(deposit_addr, need)
        swap["last_sent_txid"] = tx_hash
        swap["leg2"]["order"] = leg2
        swap["leg2"]["created"] = True
        swap["leg2"]["status"] = "routing_xmr_to_leg2"
        swap["timeline"].append("routing_xmr_to_leg2")
    except Exception as e:
        swap["leg2"]["status"] = f"leg2_create_error:{e}"
        swap["leg2"]["creating"] = False
    finally:
        _save_swaps_to_disk()

@app.get("/api/status/{swap_id}")
async def api_status(swap_id: str):
    async with SWAPS_LOCK:
        swap = SWAPS.get(swap_id)
        if not swap:
            raise HTTPException(404, "Unknown swap id")

        # Refresh provider info (leg1)
        with contextlib.suppress(Exception):
            if swap["leg1"].get("tx_id"):
                swap["leg1"]["provider_info"] = await _provider_info(swap["leg1"]["provider"], swap["leg1"]["tx_id"])

        # Mark refunded if provider shows refund (leg1)
        with contextlib.suppress(Exception):
            p1 = swap["leg1"].get("provider_info") or {}
            if _looks_refunded(p1):
                swap["leg1"]["status"] = "refunded"
                swap["refunded"] = True
                tl = swap.setdefault("timeline", [])
                if not tl or tl[-1] != "refunded":
                    tl.append("refunded")

        # ---- Expire if user never paid the provider's pay-in address within 2 hours ----
        try:
            now = time.time()
            age = now - float(swap.get("created", now))
            pinfo = swap["leg1"].get("provider_info") or {}
            st = str(pinfo.get("status") or pinfo.get("state") or pinfo.get("stage") or "").lower()

            # If provider explicitly says expired/canceled/timeout => expire immediately
            explicit_expired = any(x in st for x in ["expired", "canceled", "cancelled", "timeout", "timed out", "unpaid"])

            # Still waiting/unpaid (provider hasn't seen the user's payment)
            waiting_terms = ["waiting", "unpaid", "no payment", "await", "new", "pending"]
            still_waiting = any(w in st for w in waiting_terms) or (st.strip() == "")

            should_expire = explicit_expired or (age > 2*60*60 and still_waiting and not swap["leg2"].get("created"))
            if should_expire and not swap.get("expired"):
                swap["expired"] = True
                swap["leg1"]["status"] = "expired"
                tl = swap.setdefault("timeline", [])
                if not tl or tl[-1] != "expired":
                    tl.append("expired")
        except Exception:
            pass

        # Refresh provider info (leg2)
        with contextlib.suppress(Exception):
            if swap["leg2"].get("tx_id"):
                swap["leg2"]["provider_info"] = await _provider_info(swap["leg2"]["provider"], swap["leg2"]["tx_id"])

        # Mark refunded if provider shows refund (leg2)
        with contextlib.suppress(Exception):
            p2 = swap["leg2"].get("provider_info") or {}
            if _looks_refunded(p2):
                swap["leg2"]["status"] = "refunded"
                swap["refunded"] = True
                tl = swap.setdefault("timeline", [])
                if not tl or tl[-1] != "refunded":
                    tl.append("refunded")

        # Maybe create/send leg2
        with contextlib.suppress(Exception):
            await _maybe_create_leg2_and_send(swap)

    async with SWAPS_LOCK:
        SWAPS[swap_id] = swap
    _save_swaps_to_disk()
    return swap

# background sweeper
async def _sweeper():
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_S)
        try:
            async with SWAPS_LOCK:
                ids = list(SWAPS.keys())
            for sid in ids:
                with contextlib.suppress(Exception):
                    await api_status(sid)
        except Exception:
            pass

@app.on_event("startup")
async def on_start():
    # load persisted swaps (if any)
    try:
        loaded = _load_swaps_from_disk()
        if isinstance(loaded, dict) and loaded:
            async with SWAPS_LOCK:
                SWAPS.update(loaded)
    except Exception:
        pass

    print(f"[startup] .env loaded={env_loaded} CN_KEY={'yes' if bool(CN_KEY) else 'no'} EX_KEY={'yes' if bool(_EX_KEY) else 'no'} SS_KEY={'yes' if bool(SS_KEY) else 'no'} SS_BASE={SS_BASE}")
    asyncio.create_task(_sweeper())

# ---------------- Debug & Diagnostics ----------------
@app.post("/api/quote_debug")
async def api_quote_debug(req: QuoteRequest):
    out = {"req": req.model_dump(), "cn": None, "ex": None, "ss": None}
    with contextlib.suppress(Exception):
        out["cn"] = await cn_estimate(req.in_asset, "XMR", req.amount, req.in_network, None)
    with contextlib.suppress(Exception):
        out["ex"] = await ex_rate(req.in_asset, req.in_network, "XMR", None, req.amount, req.rate_type)
    with contextlib.suppress(Exception):
        # keep same call style (uses providers.simpleswap)
        out["ss"] = await ss_estimate(req.in_asset, "XMR", req.amount, req.in_network, None, req.rate_type)
    return out

@app.get("/api/diag/providers")
async def api_diag_providers():
    info = {
        "env_loaded": env_loaded,
        "keys_present": {
            "ChangeNOW": bool(CN_KEY),
            "Exolix": bool(_EX_KEY),
            "SimpleSwap": bool(SS_KEY),
        },
        "SS_BASE": SS_BASE,
        "last_quote_req": _last_quote_req,
        "simpleswap_min": None,
        "simpleswap_test": None,
    }
    try:
        if _last_quote_req:
            r = _last_quote_req
            nf = _ss_map_net(r["in_asset"], r["in_network"])
            mn_params = _ss_params({
                "currency_from": r["in_asset"].lower(),
                "currency_to": "xmr",
                "fixed": ("true" if (r.get("rate_type","float")=="fixed") else "false"),
            })
            if nf: mn_params["network_from"] = nf
            async with httpx.AsyncClient(timeout=12) as c:
                mn = await c.get(f"{SS_BASE}/get_min", params=mn_params)
                try: mnj = mn.json()
                except Exception: mnj = {"_text": mn.text}
                info["simpleswap_min"] = {"status": mn.status_code, "params": mn_params, "raw": mnj, "url": str(mn.request.url)}
            test = await ss_estimate(r["in_asset"], "XMR", r["amount"], r["in_network"], None, r.get("rate_type","float"))
            info["simpleswap_test"] = test
    except Exception as e:
        info["simpleswap_test"] = {"error": str(e)}
    return info

@app.get("/api/diag/version")
async def api_diag_version():
    return {"version": APP_VERSION, "SS_BASE": SS_BASE}

# ============== Admin UI route ==============
@app.get("/ui/admin")
async def admin_ui():
    admin_index = os.path.join(os.path.dirname(__file__), "static", "admin", "index.html")
    if not os.path.exists(admin_index):
        raise HTTPException(404, "Admin UI not found. Did you add static/admin/index.html?")
    return FileResponse(admin_index)

# ============== Admin API ==============
def _match_query(swap: Dict, q: str) -> bool:
    if not q: return True
    ql = q.lower()
    fields = [
        swap.get("id", ""),
        swap.get("subaddr", ""),
        json.dumps(swap.get("req", {})),
        json.dumps(swap.get("leg1", {})),
        json.dumps(swap.get("leg2", {})),
    ]
    return any(ql in str(x).lower() for x in fields)

def _compute_status_bucket(swap: Dict) -> str:
    # Expired takes precedence
    if swap.get("expired"):
        return "expired"

    # ---- ADDED: refunded bucket ----
    if swap.get("refunded"):
        return "refunded"

    leg2_status = (swap.get("leg2", {}) or {}).get("status", "") or ""
    if "error" in leg2_status.lower():
        return "failed"

    with contextlib.suppress(Exception):
        pinfo = swap.get("leg2", {}).get("provider_info", {}) or {}
        st = (pinfo.get("status") or pinfo.get("state") or pinfo.get("stage") or "").lower()
        if any(x in st for x in ["finished", "completed", "done"]):
            return "finished"

    return "active"

@app.get("/api/admin/swaps")
async def admin_list_swaps(
    status: Optional[str] = None,   # "active" | "finished" | "failed" | None
    q: Optional[str] = None,
    page: int = 1,
    page_size: int = 25
):
    page = max(1, int(page))
    page_size = min(100, max(1, int(page_size)))

    # Snapshot without holding the lock too long
    async with SWAPS_LOCK:
        items = list(SWAPS.values())

    rows = []
    for s in items:
        bucket = _compute_status_bucket(s)
        if status and bucket != status:
            continue
        if not _match_query(s, q or ""):
            continue
        rows.append({
            "id": s.get("id"),
            "created_ts": s.get("created"),
            "in_asset": s.get("req", {}).get("in_asset"),
            "in_network": s.get("req", {}).get("in_network"),
            "out_asset": s.get("req", {}).get("out_asset"),
            "out_network": s.get("req", {}).get("out_network"),
            "amount": s.get("req", {}).get("amount"),
            "leg1_provider": s.get("leg1", {}).get("provider"),
            "leg2_provider": s.get("leg2", {}).get("provider"),
            "status_bucket": bucket,
            "leg2_status": s.get("leg2", {}).get("status"),
            "our_fee_xmr": s.get("our_fee_xmr"),
        })

    total = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": rows[start:end]
    }

@app.get("/api/admin/swaps/{swap_id}")
async def admin_get_swap(swap_id: str):
    async with SWAPS_LOCK:
        s = SWAPS.get(swap_id)
    if not s:
        raise HTTPException(404, "Swap not found")

    try:
        subidx = s.get("subaddr_index")
        gross_xmr = await sum_received_for_subaddr(subidx) if isinstance(subidx, int) else 0.0
    except Exception:
        gross_xmr = 0.0

    try:
        net_xmr = max(0.0, gross_xmr - float(s.get("our_fee_xmr", 0.0)) - SEND_FEE_RESERVE)
    except Exception:
        net_xmr = 0.0

    # Add USD + % convenience fields
    try:
        prices = await coingecko_prices()
        xmr_usd = float(prices.get("XMR", 0.0) or 0.0)
    except Exception:
        xmr_usd = 0.0

    our_fee_xmr = float(s.get("our_fee_xmr") or 0.0)
    reserve = float(SEND_FEE_RESERVE or 0.0)

    gross_for_pct = float(gross_xmr or 0.0)
    if gross_for_pct <= 0.0:
        gross_for_pct = float((net_xmr or 0.0) + our_fee_xmr + reserve)

    our_fee_pct = (our_fee_xmr / gross_for_pct * 100.0) if gross_for_pct > 0 else None
    our_fee_usd = our_fee_xmr * xmr_usd

    # Provider fee (optional if you store it later; else None)
    provider_spread_xmr = None
    provider_fee_pct = None
    provider_fee_usd = None
    with contextlib.suppress(Exception):
        provider_spread_xmr = float(
            s.get("fee", {}).get("provider_spread_xmr") or
            s.get("provider_spread_xmr") or 0.0
        )
        if provider_spread_xmr == 0.0:
            provider_spread_xmr = None
    if provider_spread_xmr is not None and gross_for_pct > 0:
        provider_fee_pct = provider_spread_xmr / gross_for_pct * 100.0
        provider_fee_usd = provider_spread_xmr * xmr_usd

    return {
        "swap": s,
        "metrics": {
            "gross_xmr_seen": float(gross_xmr or 0.0),
            "our_fee_xmr": our_fee_xmr,
            "net_xmr_estimated": float(net_xmr or 0.0),
            "xmr_usd": xmr_usd,
            "our_fee_pct": our_fee_pct,
            "our_fee_usd": our_fee_usd,
            "provider_fee_xmr": provider_spread_xmr,
            "provider_fee_pct": provider_fee_pct,
            "provider_fee_usd": provider_fee_usd,
        }
    }
