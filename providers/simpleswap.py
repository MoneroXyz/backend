# providers/simpleswap.py
import os
from typing import Optional
import httpx
import contextlib
from fastapi import HTTPException

SS_KEY = os.getenv("SIMPLESWAP_API_KEY", "").strip()
SS_BASE = "https://api.simpleswap.io/v1"

def _ss_params(base: dict) -> dict:
    p = dict(base)
    if SS_KEY:
        p["api_key"] = SS_KEY
    return p

def _ss_fixed(rate_type: str) -> str:
    return "true" if rate_type == "fixed" else "false"

def _ss_map_net(asset: str, net: Optional[str]) -> Optional[str]:
    if not net: return None
    a = (asset or "").upper()
    n = (net or "").upper()
    # native coins: omit network
    if a in {"BTC", "LTC", "XMR", "ETH"}:
        return None
    if n == "ETH": return "erc20"
    if n == "TRX": return "trc20"
    if n == "BSC": return "bep20"
    return None

async def ss_estimate(frm: str, to: str, amt: float,
                      net_from: Optional[str], net_to: Optional[str],
                      rate_type: str):
    """
    Normalize SimpleSwap's varied response shapes to {'toAmount': float, ...}
    """
    async def _normalize_estimated(r: httpx.Response) -> dict:
        text = r.text
        try:
            j = r.json()
        except Exception:
            j = text
        n = 0.0
        if r.status_code == 200:
            if isinstance(j, (int, float)):
                n = float(j)
            elif isinstance(j, str):
                with contextlib.suppress(Exception):
                    n = float(j.strip())
            elif isinstance(j, dict):
                with contextlib.suppress(Exception):
                    n = float(j.get("estimated_amount") or j.get("toAmount") or 0)
        return {
            "toAmount": n,
            "_raw": j,
            "_status": r.status_code,
            "_url": str(r.request.url),
        }

    async def _call(nf: Optional[str], nt: Optional[str]):
        params = _ss_params({
            "currency_from": frm.lower(),
            "currency_to": to.lower(),
            "amount": str(amt),
            "fixed": _ss_fixed(rate_type),
        })
        if nf: params["network_from"] = nf
        if nt: params["network_to"] = nt
        async with httpx.AsyncClient(timeout=12) as c:
            r = await c.get(f"{SS_BASE}/get_estimated", params=params)
            out = await _normalize_estimated(r)
            out["_params"] = params
            return out

    nf = _ss_map_net(frm, net_from)
    nt = _ss_map_net(to, net_to)
    j = await _call(nf, nt)
    if (j.get("toAmount") or 0) > 0:
        return j
    return await _call(None, None)

async def ss_create(frm: str, to: str, amt: float, payout_address: str,
                    net_from: Optional[str], net_to: Optional[str],
                    rate_type: str, refund_address: Optional[str] = None):
    """
    Create with robust fallbacks; normalize deposit field.
    """
    nf = _ss_map_net(frm, net_from)
    nt = _ss_map_net(to, net_to)
    payload = {
        "currency_from": frm.lower(),
        "currency_to": to.lower(),
        "amount": str(amt),
        "address_to": payout_address,
        "fixed": "true" if rate_type == "fixed" else "false",
    }
    if nf: payload["network_from"] = nf
    if nt: payload["network_to"] = nt
    if refund_address: payload["refund_address"] = refund_address

    async def _normalize(j: dict) -> dict:
        if "deposit" not in j:
            if j.get("address_from"):
                j["deposit"] = j["address_from"]
            elif j.get("payinAddress"):
                j["deposit"] = j["payinAddress"]
        return j

    r1 = r2 = r3 = None
    async with httpx.AsyncClient(timeout=30) as c:
        # Try 1: POST query param
        try:
            url1 = httpx.URL(f"{SS_BASE}/create_exchange").copy_add_param("api_key", SS_KEY)
            r1 = await c.post(url1, json=payload, headers={"Content-Type": "application/json"})
            j1 = None
            try: j1 = r1.json()
            except Exception: pass
            if r1.status_code == 200 and isinstance(j1, dict):
                return await _normalize(j1)
        except Exception:
            pass

        # Try 2: POST header
        try:
            url2 = f"{SS_BASE}/create_exchange"
            r2 = await c.post(url2, json=payload, headers={"Content-Type": "application/json", "X-Api-Key": SS_KEY})
            j2 = None
            try: j2 = r2.json()
            except Exception: pass
            if r2.status_code == 200 and isinstance(j2, dict):
                return await _normalize(j2)
        except Exception:
            pass

        # Try 3: legacy GET
        try:
            params = {
                "currency_from": payload["currency_from"],
                "currency_to": payload["currency_to"],
                "amount": payload["amount"],
                "address_to": payload["address_to"],
                "fixed": payload["fixed"],
                "api_key": SS_KEY,
            }
            if nf: params["network_from"] = nf
            if nt: params["network_to"] = nt
            if refund_address: params["refund_address"] = refund_address
            r3 = await c.get(f"{SS_BASE}/get_exchange", params=params)
            j3 = None
            try: j3 = r3.json()
            except Exception: pass
            if r3.status_code == 200 and isinstance(j3, dict):
                return await _normalize(j3)
        except Exception:
            pass

    # Prefer the most informative failure
    if r2 is not None:
        raise HTTPException(status_code=502, detail=f"SimpleSwap create failed ({r2.status_code}): {r2.text}")
    if r1 is not None:
        raise HTTPException(status_code=502, detail=f"SimpleSwap create failed ({r1.status_code}): {r1.text}")
    if r3 is not None:
        raise HTTPException(status_code=502, detail=f"SimpleSwap create failed ({r3.status_code}): {r3.text}")
    raise HTTPException(status_code=502, detail="SimpleSwap create failed: unknown error")

async def ss_info(exchange_id: str):
    params = _ss_params({"id": exchange_id})
    async with httpx.AsyncClient(timeout=12) as c:
        r = await c.get(f"{SS_BASE}/get_exchange", params=params)
        r.raise_for_status()
        return r.json()
