# providers/changenow.py
import os
from typing import Optional
import httpx

CN_KEY = os.getenv("CHANGENOW_API_KEY", "").strip()

def _cn_headers() -> dict:
    h = {"Accept": "application/json", "Content-Type": "application/json"}
    if CN_KEY:
        h["x-changenow-api-key"] = CN_KEY
    return h

async def cn_estimate(frm: str, to: str, amt: float,
                      frm_net: Optional[str] = None, to_net: Optional[str] = None,
                      flow: str = "standard"):
    h = _cn_headers()
    if frm.lower() == "xmr":
        frm_net = None
    if to.lower() == "xmr":
        to_net = None

    async def _estimated(amount: float, fnet, tnet):
        params = {
            "fromCurrency": frm.lower(),
            "toCurrency": to.lower(),
            "fromAmount": str(amount),
            "flow": flow
        }
        if fnet: params["fromNetwork"] = fnet.lower()
        if tnet: params["toNetwork"] = tnet.lower()
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://api.changenow.io/v2/exchange/estimated-amount",
                            params=params, headers=h)
            if r.status_code == 200:
                j = r.json()
                v = j.get("toAmount") or j.get("estimatedAmount")
                try:
                    n = float(v) if v not in (None, "") else 0.0
                except Exception:
                    n = 0.0
                if n > 0:
                    j["toAmount"] = n
                    return j
        return {"toAmount": 0.0}

    j = await _estimated(amt, None, None)
    if j.get("toAmount", 0.0) > 0:
        return j
    j2 = await _estimated(amt, frm_net, to_net)
    if j2.get("toAmount", 0.0) > 0:
        return j2
    return await _estimated(max(1e-12, amt * 0.999), frm_net, to_net)

async def cn_create(frm: str, to: str, amt: float, payout_address: str,
                    frm_net: Optional[str] = None, to_net: Optional[str] = None,
                    flow: str = "standard", refund_address: Optional[str] = None):
    h = _cn_headers()
    if frm.lower() == "xmr":
        frm_net = None
    if to.lower() == "xmr":
        to_net = None
    body = {
        "fromCurrency": frm,
        "toCurrency": to,
        "fromAmount": str(amt),
        "address": payout_address,
        "flow": flow
    }
    if frm_net: body["fromNetwork"] = frm_net.lower()
    if to_net: body["toNetwork"] = to_net.lower()
    if refund_address: body["refundAddress"] = refund_address
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post("https://api.changenow.io/v2/exchange", json=body, headers=h)
        r.raise_for_status()
        return r.json()

async def cn_info(tx_id: str):
    h = _cn_headers()
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get("https://api.changenow.io/v2/exchange/by-id",
                        params={"id": tx_id}, headers=h)
        r.raise_for_status()
        return r.json()
