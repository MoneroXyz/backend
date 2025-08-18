# providers/exolix.py
import os
from typing import Optional
import httpx
from fastapi import HTTPException

_EX_KEY = os.getenv("EXOLIX_API_KEY", "").strip()
EX_AUTH = _EX_KEY if _EX_KEY.lower().startswith("bearer ") else (f"Bearer {_EX_KEY}" if _EX_KEY else "")

def _ex_headers() -> dict:
    h = {"Accept": "application/json", "Content-Type": "application/json"}
    if EX_AUTH:
        h["Authorization"] = EX_AUTH
    return h

def _normalize_network(asset: str, net: Optional[str]) -> Optional[str]:
    if not net:
        return None
    net = net.upper()
    if net in {"BTC", "ETH", "TRX", "BSC", "LTC", "XMR"}:
        return net
    return net

async def ex_rate(frm: str, net_from: Optional[str], to: str, net_to: Optional[str],
                  amt: float, rate_type: str = "float"):
    p = {"coinFrom": frm, "coinTo": to, "amount": str(amt), "rateType": rate_type}
    if net_from: p["networkFrom"] = net_from
    if net_to: p["networkTo"] = net_to
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://exolix.com/api/v2/rate", params=p, headers=_ex_headers())
        if r.status_code == 200:
            j = r.json()
            if float(j.get("toAmount") or 0) > 0:
                return j
        # fallback without nets
        p2 = {"coinFrom": frm, "coinTo": to, "amount": str(amt), "rateType": rate_type}
        r2 = await c.get("https://exolix.com/api/v2/rate", params=p2, headers=_ex_headers())
        return r2.json() if r2.status_code == 200 else {"toAmount": 0.0, "fromAmount": amt}

async def ex_create(frm: str, net_from: Optional[str], to: str, net_to: Optional[str],
                    amt: float, withdrawal: str, rate_type: str = "float"):
    nf = _normalize_network(frm, net_from) or frm.upper()
    nt = _normalize_network(to, net_to) or to.upper()
    b = {
        "coinFrom": frm, "coinTo": to,
        "networkFrom": nf, "networkTo": nt,
        "amount": amt, "withdrawalAddress": withdrawal,
        "rateType": rate_type
    }
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post("https://exolix.com/api/v2/transactions", json=b, headers=_ex_headers())
        if r.status_code >= 400:
            try:
                raise HTTPException(502, f"Exolix create failed ({r.status_code}): {r.json()}")
            except Exception:
                raise HTTPException(502, f"Exolix create failed ({r.status_code}): {r.text}")
        return r.json()

async def ex_info(tx_id: str):
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"https://exolix.com/api/v2/transactions/{tx_id}", headers=_ex_headers())
        r.raise_for_status()
        return r.json()
