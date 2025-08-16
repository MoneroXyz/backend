Monerizer — 2-Leg Router (in → XMR → out)

Monerizer is a tiny FastAPI service + static UI that routes swaps in two legs:

Leg-1: in_asset@in_network → XMR (to our XMR wallet)

Leg-2: XMR → out_asset@out_network (from our wallet to the chosen provider)

Currently supports assets: BTC, ETH, USDT, USDC, LTC
Networks: BTC, ETH, TRX, BSC, LTC (XMR is network-less)

UI lives at /ui and talks to the API.

How it works (high level)

Quote (POST /api/quote)

Fetches provider estimates for both legs (Exolix + ChangeNOW when available).

Builds 2×2 route combos (L1 provider × L2 provider), calculates user receive after fees.

Picks best route (highest receive_out). The UI shows best (and any other viable routes).

Start (POST /api/start)

You pass the picked leg1_provider and leg2_provider (explicit).

Creates Leg-1 order (payout to our XMR wallet). Returns a deposit address for the user.

Status & auto Leg-2 (GET /api/status/{swap_id})

Polls Leg-1 provider; once complete, records xmr_received.

Waits for wallet unlocked balance to be ≥ xmr_received - our_fee_xmr + miner fee reserve.

Creates Leg-2 order with your chosen leg2_provider (no re-quote), then sends XMR to the provider’s deposit address from our wallet.

Polls Leg-2 provider until complete.

Fee model (transparent)

We mirror the provider’s spread as our fee, in XMR.
When quoting, we estimate (roughly) the provider spread across the two legs.
We then set:

our_fee_xmr = min( max(0, spread_leg1 + spread_leg2),  FEE_CAP_RATIO * leg1_xmr )


This means: if the provider’s effective spread is 1 XMR, our fee is also ~1 XMR.

A hard cap keeps quotes sane: OUR_FEE_MAX_RATIO (default 0.15) × the XMR received on Leg-1.

The user-visible output in quotes (receive_out) already subtracts our fee.

At runtime:

accounting.xmr_received — XMR from Leg-1 provider to our wallet

accounting.our_fee_xmr — our fee withheld (in XMR)

accounting.xmr_forwarded — XMR we sent to Leg-2

Miner fee & reserve (Leg-2 send):
Monero network fee is paid by our wallet. We leave a tiny headroom XMR_SEND_FEE_RESERVE (default 0.00030 XMR) so sends never fail.

Example
Leg-1 credits 0.2700 XMR, our mirrored fee computes to 0.0130 XMR.
We forward ≈ 0.2570 XMR (minus tiny reserve for the miner fee).

Requirements

Python 3.11+ (Windows)

FastAPI + Uvicorn (installed via pip)

Monero node running locally (daemon RPC at 127.0.0.1:18081)

Monero wallet RPC (our hot wallet) at 127.0.0.1:18083 pointing to that node

Provider API access:

Exolix: API key (sent as Authorization: Bearer … if you supply a raw token)

ChangeNOW: API key (some pairs can be temporarily disabled by CN)

If ChangeNOW returns “pair_is_inactive”, those legs will be omitted automatically; Exolix-only routes still work.

Environment variables

Create a .env next to app.py:

# Providers
CHANGENOW_API_KEY=your_cn_key_here
EXOLIX_API_KEY=your_exolix_key_or_bearer_token

# Our wallet (Leg-1 payout target)
XMR_OUR_RECEIVE_ADDRESS=44...  # Your XMR primary/subaddress

# Wallet RPC (Leg-2 sender)
XMR_WALLET_RPC_URL=http://127.0.0.1:18083/json_rpc
XMR_WALLET_RPC_USER=          # leave blank if using --disable-rpc-login
XMR_WALLET_RPC_PASS=

# Fee knobs
OUR_FEE_MAX_RATIO=0.15        # cap: up to 15% of the leg-1 XMR received
XMR_SEND_FEE_RESERVE=0.00030  # headroom for Monero miner fee when sending

Run the stack (Windows / PowerShell)
1) Start the Monero daemon (already synced chain folder)
cd "E:\MoneroCLI\monero-x86_64-w64-mingw32-v0.18.4.1"

.\monerod.exe `
  --data-dir "E:\MoneroCLI\blockchain" `
  --rpc-bind-ip 127.0.0.1 `
  --rpc-bind-port 18081 `
  --confirm-external-bind


Health check:

Invoke-RestMethod http://127.0.0.1:18081/get_info |
  Select-Object height,target_height,synchronized,offline

2) Start the wallet RPC (using your wallet “smartRPC”)
cd "E:\MoneroCLI\monero-x86_64-w64-mingw32-v0.18.4.1"

.\monero-wallet-rpc.exe `
  --rpc-bind-ip 127.0.0.1 `
  --rpc-bind-port 18083 `
  --disable-rpc-login `
  --daemon-address 127.0.0.1:18081 `
  --wallet-file "E:\MoneroCLI\monero-x86_64-w64-mingw32-v0.18.4.1\smartRPC" `
  --password 1234


Quick checks:

# Wallet RPC version
Invoke-RestMethod -Uri http://127.0.0.1:18083/json_rpc -Method Post -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":"0","method":"get_version"}'

# Wallet scan height
Invoke-RestMethod -Uri http://127.0.0.1:18083/json_rpc -Method Post -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":"0","method":"get_height"}'

3) Run Monerizer API + UI
cd E:\backend
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8899 --reload


Open the UI at: http://127.0.0.1:8899/ui/

API
POST /api/quote → QuoteResponse

Input:

{
  "in_asset": "ETH",
  "in_network": "ETH",
  "out_asset": "ETH",
  "out_network": "ETH",
  "amount": 0.05,
  "rate_type": "float"
}


Output:

options[] (each with leg1, leg2, fee, receive_out)

best_index (highest receive_out)

If a provider is down/disabled for a pair (e.g., CN returns pair_is_inactive), those legs are omitted and you’ll see fewer options.

POST /api/start → StartSwapResponse

Start the route you chose:

{
  "leg1_provider": "Exolix",
  "leg2_provider": "Exolix",
  "in_asset": "ETH",
  "in_network": "ETH",
  "out_asset": "ETH",
  "out_network": "ETH",
  "amount": 0.05,
  "payout_address": "0x...",
  "rate_type": "float",
  "our_fee_xmr": 0.0123
}

GET /api/status/{swap_id}

Returns:

status (e.g., waiting_deposit, leg1_processing, leg1_complete, waiting_unlock, leg2_sent, leg2_processing, complete)

steps[] (progress trail)

leg1, leg2 (provider IDs, deposit addresses)

accounting (xmr_received, our_fee_xmr, xmr_forwarded)

Debug helpers (optional)

POST /api/quote_debug — raw leg quotes (to see what each provider returned)

POST /api/cn_probe — shows CN endpoint responses/HTTP codes for the current pair

UI notes

Asset lists: USDT(ETH) & USDT(TRX) are separate choices with the network auto-set.

Routes panel shows best route (and any other viable ones). If ChangeNOW omits a pair, you’ll see fewer routes.

Run status chips: Receiving deposit → Waiting unlock → Sending XMR → Routing → Done.

Troubleshooting

Quote shows only Exolix
Likely CN disabled that pair (pair_is_inactive) — try POST /api/cn_probe to confirm.

Leg-2 didn’t start yet
Check wallet unlocked balance vs. needed forward:

xmr_received - our_fee_xmr + XMR_SEND_FEE_RESERVE must be ≤ unlocked.

When enough unlocks, server auto-creates Leg-2 and sends.

Manual Leg-2 send (emergency)
You can query the swap, create a provider order yourself, and transfer from wallet RPC to the provider’s XMR deposit address. (Only needed if you intentionally bypass the server’s auto flow.)

Security

Keep .env local.

Wallet RPC is bound to 127.0.0.1 with --disable-rpc-login in your setup; do not expose it externally.

API keys are read from env vars; never commit them.

Roadmap (nice-to-haves)

Provider-agnostic fallbacks for disabled pairs

More assets/networks

Better UI timelines & historical list

Robust persistence instead of in-memory SWAPS{}
