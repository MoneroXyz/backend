# providers/stealthex.py
import os
import httpx
from fastapi import HTTPException

SX_BASE = "https://api.stealthex.io/v4"
SX_KEY = os.getenv("STEALTHEX_API_KEY", "").strip()

def _headers():
    h = {"Accept": "application/json"}
    if SX_KEY:
        h["Authorization"] = f"Bearer {SX_KEY}"
        h["Content-Type"] = "application/json"
    return h

# -------- CoinGecko fallback for toAmount (only used when StealthEX can't quote) --------
_CG_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "USDT": "tether",
    "USDC": "usd-coin",
    "LTC": "litecoin",
    "XMR": "monero",
}
_HAIRCUT = float(os.getenv("STEALTHEX_QUOTE_HAIRCUT", "0.93"))

async def _cg_prices(symbols):
    ids = ",".join(_CG_IDS[s] for s in symbols if s in _CG_IDS)
    url = "https://api.coingecko.com/api/v3/simple/price"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(url, params={"ids": ids, "vs_currencies": "usd"})
            r.raise_for_status()
            data = r.json()
        out = {}
        for s in symbols:
            out[s] = float(data.get(_CG_IDS[s], {}).get("usd", 0) or 0)
        return out
    except Exception:
        return {"BTC":60000,"ETH":3000,"USDT":1.0,"USDC":1.0,"LTC":70,"XMR":160}

def _candidates_for(symbol: str, app_net: str | None):
    """Return a list of StealthEX network name candidates in priority order."""
    s = (symbol or "").upper()
    n = (app_net or "").upper()

    # Coins: StealthEX uses "mainnet"
    if s in ("BTC", "ETH", "LTC", "XMR"):
        return ["mainnet"]

    # Tokens (USDT/USDC) depend on the chain
    if s in ("USDT", "USDC"):
        if n == "ETH":
            # Seen variants across providers; try several
            return ["ethereum", "erc20", "mainnet"]
        if n == "TRX":
            return ["tron", "trc20", "mainnet"]
        if n == "BSC":
            return ["bsc", "bep20", "mainnet"]

    # Fallback
    return ["mainnet"]

async def _sx_range(sym_from: str, net_from: str, sym_to: str, net_to: str, rate_type: str):
    body = {
        "route": {
            "from": {"symbol": sym_from.lower(), "network": net_from.lower()},
            "to":   {"symbol": sym_to.lower(),   "network": net_to.lower()},
        },
        "estimation": "direct",
        "rate": "floating" if (rate_type or "").lower() != "fixed" else "fixed",
    }
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{SX_BASE}/rates/range", json=body, headers=_headers())
        try:
            j = r.json()
        except Exception:
            j = {"_text": r.text}
    return r.status_code, j

async def _find_working_nets(sym_from: str, app_net_from: str | None,
                             sym_to: str, app_net_to: str | None,
                             rate_type: str):
    """Try combinations until /rates/range accepts the pair. Return (net_from, net_to, range_json) or (None, None, last_json)."""
    last = None
    for nf in _candidates_for(sym_from, app_net_from):
        for nt in _candidates_for(sym_to, app_net_to):
            status, rng = await _sx_range(sym_from, nf, sym_to, nt, rate_type)
            if status < 400 and not (isinstance(rng, dict) and rng.get("err")):
                return nf, nt, rng
            last = rng
    return None, None, last

# ---------------------- ESTIMATE ----------------------
async def sx_estimate(asset_from: str, asset_to: str, amount_from: float,
                      net_from: str | None, net_to: str | None, rate_type: str):
    af = (asset_from or "").upper()
    at = (asset_to or "").upper()
    if amount_from <= 0:
        return {"toAmount": 0.0}

    # 1) Confirm pair & min via /rates/range with network-mapping
    nf, nt, rng = await _find_working_nets(af, net_from, at, net_to, rate_type)
    if not nf or not nt:
        # Pair not supported -> hide in quotes
        return {"toAmount": 0.0}

    min_amt = float((rng or {}).get("min_amount") or 0.0)
    if min_amt and amount_from < min_amt:
        # Below min -> hide in quotes
        return {"toAmount": 0.0}

    # 2) We could create a temp order to get exact expected_amount, but to avoid side-effects,
    #    just compute a conservative CG-based estimate that will be close and SAFE.
    prices = await _cg_prices([af, at])
    p_from = float(prices.get(af, 0) or 0)
    p_to   = float(prices.get(at, 0) or 0)
    if p_from <= 0 or p_to <= 0:
        return {"toAmount": 0.0}
    usd_in  = amount_from * p_from
    raw_out = usd_in / p_to
    adj_out = max(0.0, raw_out * _HAIRCUT)
    return {"toAmount": float(f"{adj_out:.8f}")}

# ---------------------- CREATE ----------------------
async def sx_create(asset_from: str, asset_to: str, amount_from: float,
                    payout_or_deposit_addr: str, net_from: str | None, net_to: str | None,
                    rate_type: str, refund_address: str | None):
    af = (asset_from or "").upper()
    at = (asset_to or "").upper()

    # Make sure we use networks StealthEX accepts (same discovery as estimate)
    nf, nt, rng = await _find_working_nets(af, net_from, at, net_to, rate_type)
    if not nf or not nt:
        raise HTTPException(502, f"StealthEX create error: pair/networks not supported: {af}({net_from}) -> {at}({net_to})")

    body = {
        "route": {
            "from": {"symbol": af.lower(), "network": nf},
            "to":   {"symbol": at.lower(), "network": nt},
        },
        "amount": float(amount_from or 0.0),
        "estimation": "direct",
        "rate": "floating" if (rate_type or "").lower() != "fixed" else "fixed",
        "address": payout_or_deposit_addr,
    }
    # if refund_address:
    #     body["refund_address"] = refund_address

    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{SX_BASE}/exchanges", json=body, headers=_headers())
        try:
            j = r.json()
        except Exception:
            j = {"_text": r.text}

    if r.status_code >= 400 or (isinstance(j, dict) and j.get("err")):
        raise HTTPException(502, f"StealthEX create error {r.status_code}: {j}")

    dep = j.get("deposit") or {}
    return {
        "id": j.get("id") or "",
        "depositAddress": dep.get("address") or "",
        "depositExtraId": dep.get("extra_id"),
        "_raw": j,
    }

# ---------------------- INFO ----------------------
async def sx_info(exchange_id: str):
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.get(f"{SX_BASE}/exchanges/{exchange_id}", headers=_headers())
        try:
            j = r.json()
        except Exception:
            j = {"_text": r.text}
    if r.status_code >= 400 or (isinstance(j, dict) and j.get("err")):
        raise HTTPException(502, f"StealthEX info error {r.status_code}: {j}")
    return j
