// Candle Clash — local dev server + on-chain event recorder
//
// Serves the game (public/) and records game events (bets + settlements) as
// Solana DEVNET transactions through MagicBlock's Magic Router
// (ConnectionMagicRouter from @magicblock-labs/ephemeral-rollups-sdk).
// The router inspects each tx and routes it to an Ephemeral Rollup or to the
// Solana base layer; our memo transactions carry no delegated accounts, so
// they are anchored on devnet — see README.md "On-chain honesty" section.
//
// If the recorder wallet has no devnet SOL, recording is skipped gracefully
// and the game runs fully client-side. Fund the wallet printed at startup
// (faucet.solana.com, GitHub login) to switch recording on — no restart of
// the game logic needed, the server re-checks balance per request.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ROUTER_URL = 'https://devnet-router.magicblock.app';
const DEVNET_URL = 'https://api.devnet.solana.com';

// ---------- recorder wallet (devnet only, generated locally) ----------
let recorder = null;
try {
  const raw = process.env.RECORDER_SECRET
    ? process.env.RECORDER_SECRET
    : fs.readFileSync(path.join(__dirname, 'keypair.json'), 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw));
  recorder = Keypair.fromSecretKey(secret);
} catch {
  console.warn('[chain] recorder key not found — set RECORDER_SECRET or run: node genkey.mjs');
}

const baseConnection = new Connection(DEVNET_URL, 'confirmed');
let routerConnection = null;
try {
  routerConnection = new ConnectionMagicRouter(ROUTER_URL, 'confirmed');
} catch (e) {
  console.warn('[chain] Magic Router init failed, will use base devnet RPC:', e.message);
}

async function recorderBalance() {
  if (!recorder) return 0;
  try {
    return await baseConnection.getBalance(recorder.publicKey);
  } catch {
    return 0;
  }
}

// Serialize sends: one recorder wallet => avoid blockhash/nonce collisions.
let sendChain = Promise.resolve();
function recordEvent(eventObj) {
  const run = async () => {
    if (!recorder) return { onchain: false, reason: 'no recorder keypair' };
    const balance = await recorderBalance();
    if (balance < 10000) {
      return { onchain: false, reason: 'recorder wallet unfunded (needs devnet SOL from faucet.solana.com)' };
    }
    const memo = `CandleClash/1 ${JSON.stringify(eventObj)}`.slice(0, 560);
    const ix = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: recorder.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(memo, 'utf8'),
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = recorder.publicKey;

    // Preferred path: MagicBlock Magic Router (routes ER vs base layer).
    if (routerConnection) {
      try {
        const sig = await routerConnection.sendTransaction(tx, [recorder], { skipPreflight: true });
        await baseConnection.confirmTransaction(sig, 'confirmed').catch(() => {});
        return { onchain: true, via: 'magic-router', signature: sig };
      } catch (e) {
        console.warn('[chain] router send failed, falling back to devnet RPC:', e.message?.slice(0, 140));
      }
    }
    // Fallback path: plain devnet RPC.
    const { blockhash } = await baseConnection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const sig = await baseConnection.sendTransaction(tx, [recorder], { skipPreflight: false });
    await baseConnection.confirmTransaction(sig, 'confirmed').catch(() => {});
    return { onchain: true, via: 'devnet-rpc', signature: sig };
  };
  sendChain = sendChain.then(run, run);
  return sendChain;
}

// ---------- price proxy (Pyth primary, exchange fallbacks) ----------
// The browser prefers direct streams, but some networks block them; this
// same-origin endpoint keeps the game live anywhere the server has internet.
const PYTH_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
let priceCache = { at: 0, body: null };
async function fetchPrice() {
  if (Date.now() - priceCache.at < 800 && priceCache.body) return priceCache.body;
  const attempts = [
    async () => {
      const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_FEED}&parsed=true`);
      if (!r.ok) throw new Error('pyth ' + r.status);
      const j = await r.json();
      const it = j.parsed[0];
      return { price: parseInt(it.price.price, 10) * Math.pow(10, it.price.expo), source: 'Pyth Network' };
    },
    async () => {
      const r = await fetch('https://api.exchange.coinbase.com/products/SOL-USD/ticker');
      const j = await r.json();
      return { price: parseFloat(j.price), source: 'Coinbase Exchange' };
    },
    async () => {
      const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD');
      const j = await r.json();
      return { price: parseFloat(j.result.SOLUSD.c[0]), source: 'Kraken' };
    },
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const j = await r.json();
      return { price: j.solana.usd, source: 'CoinGecko' };
    },
  ];
  for (const fn of attempts) {
    try {
      const out = await fn();
      if (isFinite(out.price) && out.price > 0) {
        priceCache = { at: Date.now(), body: { ...out, ts: Date.now() } };
        return priceCache.body;
      }
    } catch { /* try next source */ }
  }
  return priceCache.body || { error: 'all price sources unreachable' };
}

// ---------- static file server + tiny API ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/status') {
    const balance = await recorderBalance();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      recorder: recorder ? recorder.publicKey.toBase58() : null,
      balanceSol: balance / LAMPORTS_PER_SOL,
      funded: balance >= 10000,
      router: ROUTER_URL,
      cluster: 'devnet',
    }));
    return;
  }

  if (url.pathname === '/api/price') {
    const body = await fetchPrice();
    res.writeHead(body.error ? 502 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (url.pathname === '/api/record' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const result = await recordEvent({ t: Date.now(), ...payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ onchain: false, reason: 'bad request: ' + e.message }));
      }
    });
    return;
  }

  const filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, async () => {
  console.log(`Candle Clash running at http://localhost:${PORT}`);
  if (recorder) {
    const bal = await recorderBalance();
    console.log(`[chain] recorder wallet (devnet): ${recorder.publicKey.toBase58()}`);
    console.log(`[chain] balance: ${bal / LAMPORTS_PER_SOL} SOL — recording ${bal >= 10000 ? 'ON' : 'OFF (fund via faucet.solana.com)'}`);
    console.log(`[chain] Magic Router: ${ROUTER_URL}`);
  }
});
