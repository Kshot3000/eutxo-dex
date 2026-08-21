# EUTXO.DEX

A decentralized exchange for the **Ergo** blockchain — red & black, non-custodial, built on the EUTXO model.
Inspired by what ErgoDEX and spectrum.fi used to be.

> Unofficial community project. Not affiliated with the Ergo Foundation. Not financial advice.

## Run it

```
double-click serve.bat
```

That starts a zero-dependency PowerShell static server and opens the app at
<http://localhost:8080>. (Any static server works: `npx serve`, VS Code Live Server, IIS…)

The app is plain ES modules — no build step, no npm, no backend.
A static server is required because the WASM signing engine (sigma-rust) must be
served with the correct MIME type.

## What works today (verified)

| Area | Status |
|---|---|
| Red/black EUTXO.DEX UI (Swap / Pools / Activity) | ✅ |
| Live chain data — height, protocol params, token registry, block activity | ✅ from public API `api.ergoplatform.com` (CORS-open) |
| ERG/USD price (CoinGecko) | ✅ |
| Token discovery — real token ids/names/decimals from the chain | ✅ |
| AMM quotes — real constant-product math, BigInt-safe, fee + price impact + slippage | ✅ |
| Pools — create/remove/reset, reserves, TVL, swap log (persisted in localStorage) | ✅ **virtual liquidity** (local settlement) |
| Wallet — create / import mnemonic (12/24) / import 32-byte seed, real sigma-rust key derivation | ✅ |
| Signing — `sign_transaction`, `sign_message` via sigma-rust WASM | ✅ (engine loads from local vendor dir or CDN) |
| Real send (ERG + tokens) | ✅ **requires a reachable full node** (Settings → Node URL), e.g. a node you run |
| Balances (unspent boxes) | ✅ requires full node |
| Testnet faucet | ✅ requires a testnet full node |
| Browser extension accounts (read-only) | best-effort, when `window.ergo` exists |

**Honest limitation:** no public full node with the UTXO API is currently
reachable, and on-chain AMM pool contracts are not deployed, so *swaps settle on
virtual (local) pools* — the math is real, the settlement is simulated, and the UI
labels it as such. Everything else (quotes, keys, signing, chain data) is real.

## Architecture

```
eutxo-dex/
├── index.html          app shell (swap / pools / activity / modals / footer)
├── css/styles.css      red & black theme
├── js/
│   ├── config.js       networks, tokens, donations, fees, storage keys
│   ├── api.js          gateway (verified endpoints) + optional full-node client
│   ├── amm.js          constant-product pool engine (BigInt math) + persistence
│   ├── wallet.js       sigma-rust wallet: keys, address, sign tx/message
│   └── app.js          state, rendering, events, toasts, modals
├── vendor/ergo-lib/    ergo-lib-wasm-browser v0.28.0 (sigma-rust WASM, CC0)
├── assets/             logo + favicon (SVG)
├── tests/              verification suites (AMM math, wallet vectors, signed-tx proofs)
├── package.json        test scripts (no runtime deps)
├── serve.ps1/.bat      zero-dependency Windows static server
└── README.md
```

### Data sources (probed & verified 2026-08-21)

- `GET https://api.ergoplatform.com/api/v1/info` — height, protocol params
- `GET https://api.ergoplatform.com/api/v1/tokens?limit=&offset=` — token registry
- `GET https://api.ergoplatform.com/api/v1/tokens/{id}` — token details
- `GET https://api.ergoplatform.com/api/v1/blocks?limit=` — recent block list
- `GET https://api.ergoplatform.com/api/v1/blocks/{id}` — full block (txs + assets) → used to score active tokens
- `https://api.coingecko.com/api/v3/simple/price?ids=ergo&vs_currencies=usd` — ERG price
- Optional full node (your URL): `/addresses/{a}/unspent`, `/blocks/tip`, `POST /transactions`, `POST /faucet`

### Wallet security model

- New wallet = 32 random bytes (CSPRNG `crypto.getRandomValues`) stored as the dlog secret — the same key type official Ergo keystores use.
- Import = 12/24-word mnemonic (BIP39 seed → HMAC-SHA512("Bitcoin seed") → sigma-rust master key, matching sigma-rust's own derivation) or a raw 32-byte seed.
- Keys stay in the browser. "Remember on this device" writes them to `localStorage` (visible to anyone with this browser) — the UI warns about that and offers a wipe.
- Signed transactions are built with sigma-rust in WASM and broadcast only to the node URL you configure.

### Roadmap to full on-chain settlement

1. Compile a sigma-rs pool contract (deposit/withdraw/swap, LP mint/burn) → ergoTree.
2. Add `DeployPool` + `Swap` transaction builders in `wallet.js` (context extension, R-registers, pool box as input).
3. Point the swap button at real settlement when a pool contract exists on-chain; keep virtual pools as a zero-deployment demo mode.
4. Add 24h volume/fees from block scans for real pool TVL.

## Credits

- sigma-rust / ergo-lib-wasm — [ergoplatform/sigma-rust](https://github.com/ergoplatform/sigma-rust) (CC0)
- Ergo node public API & explorer — ergoplatform
- Design: EUTXO.DEX
