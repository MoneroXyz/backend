Monerizer Backend

Monerizer is a privacy-focused swap orchestrator. It enforces two-leg routing (ANY\_IN → XMR → ANY\_OUT) so that all user swaps are shielded through Monero before exiting.



Overview

Leg 1: User sends IN asset (e.g. ETH, BTC, USDT). Monerizer creates a swap with a provider (Exolix / ChangeNOW). Provider delivers XMR to a unique subaddress in our Monero wallet.

Leg 2: Once enough unlocked XMR is available at that subaddress (minus our fee \& reserve), Monerizer sends XMR to a second provider to complete the OUT leg.



Privacy guarantee: Providers never see both sides of the swap. User’s IN → our XMR subaddress → OUT.

Fee capture: Our fee is retained in XMR, never converted out. This makes Monerizer inherently profitable in Monero.



⚙️ Architecture

Components:



FastAPI backend (app.py): Manages swap lifecycle, provider API calls, wallet RPC.



UI (index.html, style.css, app.v5.js): Client interface to get quotes, start swaps, track statuses.



Monero wallet RPC: Runs locally, generates subaddresses, tracks balances, sends leg-2 payouts.



Providers: Currently Exolix, ChangeNOW, SimpleSwap, and StealthEX are integrated.

\[NEW] Providers are now extracted into a dedicated folder so app.py is slimmer and easier to maintain:



providers/: Exolix / ChangeNOW (and future providers).



services/: wallet helpers and related logic.



routers/: API endpoints split out cleanly.



\[NEW] Admin UI is available in static/admin and served at /ui/admin. It lists swaps by status and shows details (providers, IDs, amounts, fees, subaddress, txids, timestamps).



Flow

Quote (/api/quote)

Queries both providers for IN → XMR and XMR → OUT pairs. Calculates implied provider fee. Applies our own fee policy:

our\_fee = min(provider\_spread, OUR\_FEE\_MAX\_RATIO × leg1\_xmr)

Our fee is retained in Monero.



Start swap (/api/start)

User chooses leg1\_provider + leg2\_provider.



Backend creates leg-1 order at provider.



Monerizer requests a new XMR subaddress via wallet RPC.



Provider instructed to pay out XMR to that subaddress.



Swap status = waiting\_deposit.



Leg 1 complete

When provider marks order done and Monerizer detects unlocked balance at that subaddress, status = leg1\_complete.



Leg 2 auto-execution

Monerizer checks:

unlocked\_balance(subaddress) ≥ (received\_xmr - our\_fee) + XMR\_SEND\_FEE\_RESERVE

If true → send XMR from wallet to leg2 provider deposit.

Swap status = leg2\_in\_progress.



Completion

Provider finishes OUT delivery. Status = done.



\[NEW] Admin status buckets

The admin UI groups swaps as: Active, Expired, Failed, Completed, Refunded.



— Active: swap created or in progress.

— Expired: no user deposit to provider’s Leg-1 address within 2 hours.

— Failed: something went wrong after deposit (provider reject/error, or leg-2 send failed).

— Completed: both legs finished successfully.

（UI label “Completed” — underlying status “done/finished”）

— Refunded: a provider marked the swap as refunded/returned (e.g., leg‑1 refund before leg‑2).



Fee Policy

Basis: Our fee mirrors provider spread but capped.

Formula: our\_fee = min(provider\_fee, OUR\_FEE\_MAX\_RATIO × leg1\_xmr)

Retention: Fee stays in Monero. We never pay it forward.

Reserve: A small constant (XMR\_SEND\_FEE\_RESERVE, default 0.00030) is subtracted to ensure transactions succeed without dust errors.



Example:

User swaps 1 ETH → Exolix converts → 10 XMR received.

Provider implied fee = 1%. Our cap = 15%.

Our fee = 0.1 XMR (1%).

Available for leg-2 = 9.9 − 0.0003 = 9.8997 XMR.



Swap Status Lifecycle

created → Swap object created.

waiting\_deposit → Awaiting IN deposit to provider.

leg1\_in\_progress → Provider processing leg 1.

leg1\_complete → Provider marked done and payout detected at subaddress.

leg2\_in\_progress → Monerizer sent XMR to second provider.

done → OUT asset delivered.

failed → Any unrecoverable error.



\[NEW] Admin status mapping:

waiting\_deposit (no user pay-in for 2h) → Expired

done → Completed (UI label only)

failed → Failed

refund/refunded (from provider info) → Refunded

everything else that’s still moving → Active



️ Wallet \& Subaddress Logic

Wallet file: smartRPC (local only). No RPC auth (runs on 127.0.0.1:18083).

Subaddresses: Each swap generates a fresh subaddress. Ensures one-to-one mapping: swap ↔ XMR subaddress. Avoids mixing and allows precise balance tracking.

Balance check: We poll RPC get\_balance(account\_index, address\_index) until unlocked balance is enough to trigger leg-2.



Refund addresses

\[NEW] UI \& backend wiring:



Leg‑1 refund address (user): The UI accepts an optional Refund address. If the chosen leg‑1 provider requests/refunds, we pass the user’s refund address through to leg‑1.



Leg‑2 refund address (our side): When creating leg‑2, if the provider requires a refund address, we supply our XMR subaddress for that swap. This ensures any leg‑2 refund comes back to us.



️ Setup (Windows)

Run Monero daemon:



.\\monerod.exe --data-dir "E:\\MoneroCLI\\blockchain" --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18081 --prune-blockchain --confirm-external-bind





Run Wallet RPC:



.\\monero-wallet-rpc.exe --wallet-file "E:\\MoneroCLI\\monero-x86\_64-w64-mingw32-v0.18.4.1\\smartRPC" --password "1234" --rpc-bind-port 18083 --disable-rpc-login --confirm-external-bind





Run backend:



uvicorn app:app --host 127.0.0.1 --port 8899 --reload





UI

/ui/ → Main entrypoint.

index.html → Structure.

style.css → Styling.

app.v5.js → Logic (quotes, start, status).

\[NEW] /ui/admin → Admin dashboard (Active, Expired, Failed, Completed, Refunded; details show provider IDs, subaddress, txids, fees with % and USD, and timestamps with timezone/UTC note).

Current state: Pair selector fixed. Quote button functional again. Timeline shows Deposit → Routing → Sending → Done. Visual design = basic (to be improved).



Changelog

Aug 2025

Added subaddress per swap.

Changed leg1\_complete detection → requires payout on subaddress.

Added auto leg-2 execution once unlocked funds available.

Updated fee policy docs.

Updated UI (pair selector fix, working quote).

README merged + expanded.



\[NEW] Mid-Aug 2025

— Extracted provider integrations into providers/ (app.py slimmer).

— Added Admin UI at /ui/admin (status buckets: Active, Expired, Failed, Completed; “done/finished” shown as “Completed” in UI).

— Added 2h expiry for unfunded Leg-1 (admin bucket “Expired”).

— Kept fee retention in XMR only (never forwarded on leg-2).

— (Already integrated) SimpleSwap support for quotes and execution.



➕ \[Update: Mid-Aug 2025]

Integrated third provider: SimpleSwap (for both quote and swap execution).

Fixed JSON handling in start flow to avoid “Unexpected token Internal Server Error” issue.

Extended leg-2 guards: swap now executes only after unlocked balance check passes (prevents premature release).

Tested SimpleSwap on both legs:

– Works as leg-1 provider (IN → XMR).

– Works as leg-2 provider (XMR → OUT).



\[NEW] Late Aug 2025

— Integrated StealthEX (quotes + execution).

— Added Refunded status bucket in Admin (surfaced from provider status).

— Implemented refund address handling: UI input for user leg‑1 refunds; leg‑2 uses our XMR subaddress for refunds.

