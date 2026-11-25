# 🕯️ Candle Clash

**A real-time SOL price-prediction game — "Entertainment Finance" for Solana Blitz v10 (MagicBlock).**

Call it right, climb the board: every 30 seconds a new round opens. Pick **UP** or **DOWN**
for SOL/USD, stake play credits, and the round settles the instant it expires against the
real live price. Wins pay **1.9×**, streaks heat up, and every bet and settlement is
recorded as a Solana **devnet** transaction routed through **MagicBlock's Magic Router**.

![Candle Clash gameplay](demo-screenshot.png)

## Play it

```bash
npm install        # once (installs @solana/web3.js + MagicBlock ER SDK)
node genkey.mjs    # once — creates the local DEVNET recorder keypair (keypair.json, mode 600)
npm start          # serves http://localhost:8080
```

Open **http://localhost:8080** — that's it. No wallet, no signup, no real money.

- **Fast demo mode:** http://localhost:8080/?round=6 → 6-second rounds (great for judging/videos).
- Default is 30-second rounds, aligned to the wall clock so every viewer sees the same round.
- Start balance: **1,000 play credits**. Stakes: 10 / 25 / 50 / 100. Broke? One tap refills 1,000.
- Betting locks ~3 s before expiry; ties refund the stake ("push").

## How it works

```
 Browser (public/index.html)                Server (server.js)
 ┌──────────────────────────────┐          ┌────────────────────────────────┐
 │ Pyth Hermes SSE ──┐          │          │ GET /api/price  → Pyth Hermes  │
 │ Coinbase WS ──────┼─► ticks  │          │   └ fallbacks: Coinbase →      │
 │ /api/price poll ──┘          │          │      Kraken → CoinGecko        │
 │                              │  POST    │                                │
 │ round engine (30 s, wall-    │ /api/    │ POST /api/record → Memo tx via │
 │ clock aligned) · bets ·      │ record   │ ConnectionMagicRouter          │
 │ streaks · leaderboard ·      ├─────────►│ (MagicBlock ER SDK) ──► Magic  │
 │ history · localStorage       │          │ Router ──► Solana DEVNET       │
 └──────────────────────────────┘          └────────────────────────────────┘
```

- **Price feed — Pyth first.** Primary source is the **Pyth Network** (Hermes API,
  SOL/USD feed `ef0d8b6f…b56d`, SSE stream + REST). Because some networks/IPs get a
  401 from Hermes' public endpoint, the game automatically falls back to a Coinbase
  WebSocket stream and a server-side REST cascade (Coinbase → Kraken → CoinGecko).
  The UI always names the source that is actually feeding it.
- **Round engine.** Rounds are wall-clock aligned (`floor(now/30)`), the open price is
  the last tick at or before the round start, the close is the last tick at or before
  expiry. One bet per round; settlement is instant at rollover.
- **Leaderboard.** Session leaderboard with simulated rival players whose scores drift
  each round; your row ("YOU") is ranked live by your credit balance.

## On-chain honesty — exactly what is (and isn't) on-chain

| Piece | Where it lives |
|---|---|
| Bet + settlement records | **Solana devnet**, as Memo-program transactions (`CandleClash/1 {json}`), sent through **MagicBlock's Magic Router** (`ConnectionMagicRouter` from `@magicblock-labs/ephemeral-rollups-sdk`, endpoint `https://devnet-router.magicblock.app`). Tx signatures appear as "bet tx / settle tx" links in the game's Round History. |
| Magic Router routing | The router inspects each transaction and routes it to an Ephemeral Rollup or the base layer. Our memo transactions touch **no delegated accounts**, so the router anchors them on devnet L1. This is genuine Magic Router integration, but it is **not** a delegated-ER execution session. |
| Full Ephemeral Rollup delegation | **Not implemented** — it requires a custom Anchor program with a `delegate` instruction (Rust + Anchor toolchain + a devnet program deployment), which was out of scope for this build environment. The recorder design is delegation-ready: swap the Memo instruction for a game-program instruction whose state PDA is delegated, and the same router path executes it inside an ER. |
| Balances, streaks, stats, leaderboard rivals | **Client-side** (localStorage + in-page simulation). Play credits have no token and no monetary value. |
| Recorder wallet | A fresh **devnet-only** keypair generated locally (`keypair.json`, mode 600). It holds no real funds and is never used on mainnet. |

**Recording switch:** the server checks the recorder balance per request. With ≥ 0.00001 SOL
of devnet SOL it records every event; with 0 balance it logs gracefully and the game runs
fully client-side (the header pill shows which mode you're in). To switch recording on,
send a little devnet SOL to the address printed by `npm start` via
[faucet.solana.com](https://faucet.solana.com) (GitHub login), or `node fund.mjs` where the
RPC faucet is available.

## Demo script (~90 seconds)

1. **(0:00)** Open the game. Point at the live SOL/USD price ticking and the streaming
   chart with the amber "round open" line. "This is Candle Clash — a 30-second
   price-prediction game running on live Pyth prices."
2. **(0:15)** Show the balance (1,000 play credits), pick stake **50**, hit **▲ UP**.
   "One tap, one call. Betting locks just before the round ends."
3. **(0:30)** *(Use `?round=6` so this lands fast.)* Round expires — toast fires,
   payout lands, streak flame increments, the result appears in Round History.
   "Settlement is instant, against the real closing price — wins pay 1.9×."
4. **(0:50)** Scroll: stats strip (win rate, net profit) and the leaderboard with
   "YOU" ranked among the rivals. Place a second call, **▼ DOWN** this time.
5. **(1:05)** Point at the header pill and a "settle tx" link in Round History:
   "Every bet and settlement is written to Solana devnet through MagicBlock's
   Magic Router — the fast lane built for real-time apps like this. Play credits
   only; the same path carries a delegated Ephemeral Rollup session in production."
6. **(1:20)** Close: "Candle Clash — trading turned into a 30-second game.
   Built for Solana Blitz v10."

## Files

| File | Purpose |
|---|---|
| `public/index.html` | The whole game (UI + engine), single file |
| `server.js` | Static server + `/api/price` proxy + `/api/record` Magic Router recorder |
| `genkey.mjs` / `fund.mjs` | Devnet recorder keypair generation / airdrop helper |
| `test-e2e.mjs` | Headless end-to-end test (price → bet → settlement ×2) |
| `BUILDLOG.md` | What was built, verified, and what remains |
| `keypair.json` | Devnet recorder secret — **mode 600, never share, worthless by design** |

## Submission notes (Solana Blitz v10)

- Event: Solana Blitz v10 — Entertainment Finance, by MagicBlock (Luma: luma.com/hedv5sgh)
- Deadline: **27 Nov 2026, 22:00 SGT (19:30 IST)** — submit at build.magicblock.app
- Suggested title: *Candle Clash — the 30-second SOL price game*
- Suggested one-liner: *A real-time Entertainment Finance game: call SOL up or down in
  30-second rounds on live Pyth prices, with bets and settlements recorded on Solana
  devnet through MagicBlock's Magic Router.*
