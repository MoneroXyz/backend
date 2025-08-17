Monerizer Backend

Monerizer is a privacy-focused swap orchestrator. It enforces two-leg routing (ANY_IN → XMR → ANY_OUT) so that all user swaps are shielded through Monero before exiting.

📌 Overview

Leg 1: User sends IN asset (e.g. ETH, BTC, USDT). Monerizer creates a swap with a provider (Exolix / ChangeNOW). Provider delivers XMR to a unique subaddress in our Monero wallet.

Leg 2: Once enough unlocked XMR is available at that subaddress (minus our fee & reserve), Monerizer sends XMR to a second provider to complete the OUT leg.

Privacy guarantee: Providers never see both sides of the swap. User’s IN → our XMR subaddress → OUT.

Fee capture: Our fee is retained in XMR, never converted out. This makes Monerizer inherently profitable in Monero.

⚙️ Architecture

Components:

FastAPI backend (app.py): Manages swap lifecycle, provider API calls, wallet RPC.

UI (index.html, style.css, app.v5.js): Client interface to get quotes, start swaps, track statuses.

Monero wallet RPC: Runs locally, generates subaddresses, tracks balances, sends leg-2 payouts.

Providers: Currently Exolix and ChangeNOW are integrated.

Flow:

Quote (/api/quote)

Queries both providers for IN → XMR and XMR → OUT pairs.

Calculates implied provider fee.

Applies our own fee policy:

our_fee = min(provider_spread, OUR_FEE_MAX_RATIO × leg1_xmr)

Our fee is retained in Monero.

Start swap (/api/start)

User chooses leg1_provider + leg2_provider.

Backend creates leg-1 order at provider.

Monerizer requests a new XMR subaddress via wallet RPC.

Provider instructed to pay out XMR to that subaddress.

Swap status = waiting_deposit.

Leg 1 complete

When provider marks order done and Monerizer detects unlocked balance at that subaddress, status = leg1_complete.

Leg 2 auto-execution

Monerizer checks:

unlocked_balance(subaddress) ≥ (received_xmr - our_fee) + XMR_SEND_FEE_RESERVE

If true → send XMR from wallet to leg2 provider deposit.

Swap status = leg2_in_progress.

Completion

Provider finishes OUT delivery.

Status = done.

💰 Fee Policy

Basis: Our fee mirrors provider spread but capped.

Formula:

our_fee = min(provider_fee, OUR_FEE_MAX_RATIO × leg1_xmr)

Retention: Fee stays in Monero. We never pay it forward.

Reserve: A small constant (XMR_SEND_FEE_RESERVE, default 0.00030) is subtracted to ensure transactions succeed without dust errors.

Example:

User swaps 1 ETH → Exolix converts → 10 XMR received.

Provider implied fee = 1%. Our cap = 15%.

Our fee = 0.1 XMR (1%).

Available for leg-2 = 9.9 − 0.0003 = 9.8997 XMR.

🔀 Swap Status Lifecycle

created → Swap object created.

waiting_deposit → Awaiting IN deposit to provider.

leg1_in_progress → Provider processing leg 1.

leg1_complete → Provider marked done and payout detected at subaddress.

leg2_in_progress → Monerizer sent XMR to second provider.

done → OUT asset delivered.

failed → Any unrecoverable error.

🗂️ Wallet & Subaddress Logic

Wallet file: smartRPC (local only).

No RPC auth (runs on 127.0.0.1:18083).

Subaddresses:

Each swap generates a fresh subaddress.

Ensures one-to-one mapping: swap ↔ XMR subaddress.

Avoids mixing and allows precise balance tracking.

Balance check:

We poll RPC get_balance(account_index, address_index) until unlocked balance is enough to trigger leg-2.

🖥️ Setup (Windows) Run Monero daemon: .\monerod.exe --data-dir "E:\MoneroCLI\blockchain" --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18081 --prune-blockchain --confirm-external-bind

Run Wallet RPC: .\monero-wallet-rpc.exe --wallet-file "E:\MoneroCLI\monero-x86_64-w64-mingw32-v0.18.4.1\smartRPC" --password "1234" --rpc-bind-port 18083 --disable-rpc-login --confirm-external-bind

Run backend: uvicorn app:app --host 127.0.0.1 --port 8899 --reload

🌐 UI

/ui/ → Main entrypoint.

index.html → Structure.

style.css → Styling.

app.v5.js → Logic (quotes, start, status).

Current state:

Pair selector fixed.

Quote button functional again.

Timeline shows Deposit → Routing → Sending → Done.

Visual design = basic (to be improved).

📜 Changelog Aug 2025

Added subaddress per swap.

Changed leg1_complete detection → requires payout on subaddress.

Added auto leg-2 execution once unlocked funds available.

Updated fee policy docs.

Updated UI (pair selector fix, working quote).

README merged + expanded.

➕ [Update: Mid-Aug 2025]

Integrated third provider: SimpleSwap (for both quote and swap execution).

Fixed JSON handling in start flow to avoid “Unexpected token Internal Server Error” issue.

Extended leg-2 guards: swap now executes only after unlocked balance check passes (prevents premature release).

Tested SimpleSwap on both legs:
– Works as leg-1 provider (IN → XMR).
– Works as leg-2 provider (XMR → OUT).