/* EUTXO.DEX — application controller (vanilla ES modules, no build step). */
import { CONFIG } from './config.js';
import { ErgoApi, getErgoUsdPrice, ApiError } from './api.js';
import { PoolEngine, parseUnits, formatUnits, shortAmount } from './amm.js';
import {
  Wallet, loadErgoLib, createSeedHex, validateMnemonic, validateSeed, detectExtension,
} from './wallet.js';

const el = (id) => document.getElementById(id);
const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- state ---------------- */
const state = {
  network: 'mainnet',
  api: null,
  chain: null,
  price: null,
  tokens: [],            // merged token list
  tokenMap: new Map(),
  pools: new PoolEngine(),
  wallet: null,          // Wallet instance
  walletRecord: null,    // {type, value, networkId, remembered}
  address: null,
  balances: null,        // { ergNano: bigint, tokens: Map(id->bigint) }
  nodeOk: false,
  tab: 'swap',
  swap: { from: 'ERG', to: CONFIG.defaultPools[0].quote, slippage: CONFIG.ui.slippageOptions[0] },
  cp: { a: 'ERG', b: CONFIG.defaultPools[0].quote },
  tokenSelectFor: null,  // 'swap-from' | 'swap-to' | 'send' | 'cp-a' | 'cp-b'
  tsQuery: '',
  activity: [],
  settings: { nodeUrl: CONFIG.node.defaultMainnet },
  ergoLib: null,
};

/* ---------------- utils ---------------- */
function toast(msg, kind = 'info', ms = 4200) {
  const box = el('toasts');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard', 'ok'); }
    catch { toast('Copy failed — select manually', 'warn'); }
    ta.remove();
  }
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 55%)`;
}

function tokenIconHtml(t) {
  if (t.icon === 'erg') {
    return `<svg viewBox="0 0 32 32" width="100%" height="100%"><path d="M16 2 28 9v14L16 30 4 23V9z" fill="#141419" stroke="#ff7a1a" stroke-width="2"/><path d="M10.5 11h9.5v2.6h-9.5V11zm0 4.9h9.5v2.6h-9.5v-2.6zm0 4.9h6v2.6h-6v-2.6z" fill="#ffb14d"/></svg>`;
  }
  const sym = (t.symbol || '?').slice(0, 3).toUpperCase();
  const bg = t.color || hashColor(t.id);
  return `<span class="tk-c" style="--c:${esc(bg)}">${esc(sym)}</span>`;
}

function tokenById(id) {
  return state.tokenMap.get(id) || null;
}

function symbolOf(id) {
  const t = tokenById(id);
  return t ? t.symbol : `${id.slice(0, 6)}…`;
}

function decimalsOf(id) {
  const t = tokenById(id);
  return t ? t.decimals : 8;
}

function shortAddr(a) {
  if (!a) return '';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}

/** Escape a string for safe insertion into innerHTML (gateway names, user input). */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** BigInt from a node JSON value (string/number) without Number() precision loss. */
function jsonBigInt(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') { const t = v.trim(); if (!/^-?\d+$/.test(t)) throw new Error(`Bad number: ${v}`); return BigInt(t); }
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : BigInt(Math.round(v));
  return 0n;
}

/* ---------------- tokens ---------------- */
function upsertToken(t) {
  const existing = state.tokenMap.get(t.id);
  if (existing) {
    Object.assign(existing, t);
    return;
  }
  state.tokenMap.set(t.id, t);
  state.tokens.push(t);
}

function seedTokens() {
  for (const t of CONFIG.tokens) upsertToken({ ...t });
}

async function refreshGatewayTokens() {
  try {
    const j = await state.api.tokens(120, 0);
    const items = (j && j.items) || [];
    for (const it of items) {
      const id = it.id;
      if (!id) continue;
      const known = state.tokenMap.get(id);
      upsertToken({
        id,
        symbol: it.name || id.slice(0, 6).toUpperCase(),
        name: it.name || '',
        decimals: Number.isFinite(it.decimals) ? it.decimals : 8,
        color: known ? known.color : hashColor(id),
        icon: known ? known.icon : 'generic',
        gateway: true,
      });
    }
  } catch {
    /* offline — seeded tokens still available */
  }
}

async function ensureToken(id) {
  if (id === 'ERG' || state.tokenMap.has(id)) return tokenById(id);
  try {
    const it = await state.api.token(id);
    if (it && it.id) {
      upsertToken({
        id: it.id,
        symbol: it.name || id.slice(0, 6).toUpperCase(),
        name: it.name || '',
        decimals: Number.isFinite(it.decimals) ? it.decimals : 8,
        color: hashColor(id),
        icon: 'generic',
      });
      return tokenById(id);
    }
  } catch { /* fall through */ }
  upsertToken({ id, symbol: id.slice(0, 6).toUpperCase(), name: 'Unknown token', decimals: 8, color: hashColor(id), icon: 'generic' });
  return tokenById(id);
}

/* ---------------- chain data ---------------- */
async function refreshChain() {
  try {
    const info = await state.api.info();
    state.chain = info;
    const h = info.height;
    el('height-val').textContent = h != null ? Number(h).toLocaleString() : '—';
    el('stat-height').textContent = h != null ? Number(h).toLocaleString() : '—';
    setNetBadge(true);
  } catch {
    el('height-val').textContent = 'offline';
    el('stat-height').textContent = 'offline';
    setNetBadge(false);
  }
}

function setNetBadge(ok) {
  const b = el('net-badge');
  b.textContent = CONFIG.networks[state.network].label.toUpperCase() + (ok ? '' : ' • OFFLINE');
  b.classList.toggle('off', !ok);
}

async function refreshPrice() {
  state.price = await getErgoUsdPrice();
  el('stat-price').textContent = state.price ? `$${state.price.toFixed(4)}` : '—';
  el('stat-price-sub').textContent = state.price ? 'coingecko · live' : 'unavailable';
  renderStats();
}

async function refreshActivity() {
  try {
    const { scores } = await state.api.tokenActivity(CONFIG.ui.activityBlocks);
    const active = new Set(scores.map((s) => s.id));
    el('stat-active').textContent = active.size || 0;
    for (const t of state.tokens) t.active = active.has(t.id);
    renderTokenSelect();
  } catch {
    el('stat-active').textContent = '—';
  }
}

function renderStats() {
  el('stat-pools').textContent = state.pools.pools.length;
  el('stat-tvl').textContent = renderTvl();
}

function renderTvl() {
  const usd = state.pools.tvlUsd(state.price);
  return usd == null ? '—' : `$${usd >= 1e6 ? (usd / 1e6).toFixed(2) + 'M' : usd.toFixed(0)}`;
}

/* ---------------- swap UI ---------------- */
function currentPool() {
  return state.pools.getPool(state.swap.from, state.swap.to);
}

function renderSwapHead() {
  el('sym-from').textContent = symbolOf(state.swap.from);
  el('sym-to').textContent = symbolOf(state.swap.to);
  el('icon-from').innerHTML = tokenIconHtml(tokenById(state.swap.from) || { id: state.swap.from, symbol: symbolOf(state.swap.from) });
  el('icon-to').innerHTML = tokenIconHtml(tokenById(state.swap.to) || { id: state.swap.to, symbol: symbolOf(state.swap.to) });
  const pool = currentPool();
  el('meta-fee').textContent = pool ? `${(pool.feeBps / 100).toFixed(2)}%` : '—';
  el('est-fee').textContent = pool ? `fee ${(pool.feeBps / 100).toFixed(2)}%` : 'no pool';
}

function renderBalancesRow() {
  if (!state.wallet || !state.balances) {
    el('bal-from').textContent = state.wallet ? '—' : 'connect';
    return;
  }
  const id = state.swap.from;
  const nano = id === 'ERG' ? state.balances.ergNano : (state.balances.tokens.get(id) || 0n);
  el('bal-from').textContent = shortAmount(nano, decimalsOf(id));
}

function updateQuote() {
  const amt = el('amt-from').value.trim();
  const pool = currentPool();
  const out = el('amt-to');
  if (!pool) {
    out.value = '';
    el('min-to').textContent = '—';
    el('meta-rate').textContent = 'no pool';
    el('meta-impact').textContent = '—';
    el('btn-swap').textContent = state.wallet ? 'No pool for this pair' : 'Connect wallet to swap';
    el('btn-swap').classList.add('disabled');
    return;
  }
  if (!amt) {
    out.value = '';
    el('min-to').textContent = '—';
    el('meta-rate').textContent = '—';
    el('meta-impact').textContent = '—';
    setSwapReady();
    return;
  }
  let inNano;
  try {
    inNano = parseUnits(amt, decimalsOf(state.swap.from));
  } catch (e) {
    out.value = '';
    el('meta-rate').textContent = 'invalid amount';
    el('btn-swap').classList.add('disabled');
    return;
  }
  let q;
  try {
    q = state.pools.quote(pool, state.swap.from, inNano, state.swap.slippage);
  } catch (e) {
    out.value = '';
    el('meta-rate').textContent = e.message || 'quote failed';
    el('btn-swap').classList.add('disabled');
    return;
  }
  out.value = formatUnits(q.outAmount, decimalsOf(state.swap.to), 8);
  el('min-to').textContent = formatUnits(q.minOut, decimalsOf(state.swap.to), 4);
  const rate = formatUnits(q.outAmount, decimalsOf(state.swap.to), 4) + ' ' + symbolOf(state.swap.to) + ' / 1 ' + symbolOf(state.swap.from);
  el('meta-rate').textContent = rate;
  const impactPct = Number(q.priceImpactBps) / 100;
  el('meta-impact').textContent = impactPct >= 100 ? '>100%' : `${impactPct.toFixed(2)}%`;
  el('meta-impact').classList.toggle('bad', impactPct > 5);
  setSwapReady();
}

function setSwapReady() {
  const ready = !!state.wallet && !!currentPool() && !!el('amt-from').value.trim();
  el('btn-swap').classList.toggle('disabled', !ready);
  el('btn-swap').textContent = state.wallet ? (currentPool() ? 'Swap (virtual settlement)' : 'No pool for this pair') : 'Connect wallet to swap';
}

function doSwap() {
  const amt = el('amt-from').value.trim();
  const pool = currentPool();
  if (!state.wallet || !pool || !amt) return;
  let inNano, q;
  try {
    inNano = parseUnits(amt, decimalsOf(state.swap.from));
    q = state.pools.quote(pool, state.swap.from, inNano, state.swap.slippage);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  state.pools.applySwap(pool, state.swap.from, q);
  const entry = {
    ts: Date.now(),
    kind: 'swap',
    text: `${formatUnits(inNano, decimalsOf(state.swap.from), 4)} ${symbolOf(state.swap.from)} → ${formatUnits(q.outAmount, decimalsOf(state.swap.to), 4)} ${symbolOf(state.swap.to)}`,
    detail: `pool ${symbolOf(pool.base)}/${symbolOf(pool.quote)} · fee ${(pool.feeBps / 100).toFixed(2)}% · impact ${(Number(q.priceImpactBps) / 100).toFixed(2)}% · virtual settlement`,
  };
  pushActivity(entry);
  el('amt-from').value = '';
  toast(`Swapped ${symbolOf(state.swap.from)} → ${symbolOf(state.swap.to)} (virtual settlement)`, 'ok');
  updateQuote();
  renderPools();
  renderStats();
}

/* ---------------- pools ---------------- */
function renderPools() {
  const body = el('pools-body');
  body.innerHTML = '';
  const usd = state.price;
  for (const p of state.pools.pools) {
    const bt = tokenById(p.base) || { symbol: symbolOf(p.base), decimals: decimalsOf(p.base) };
    const qt = tokenById(p.quote) || { symbol: symbolOf(p.quote), decimals: decimalsOf(p.quote) };
    const rB = BigInt(p.rBase);
    const rQ = BigInt(p.rQuote);
    const tvlNano = rB + rQ;
    const tvl = usd ? (Number(tvlNano) / 1e9) * usd : null;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pair-cell">
        <span class="pair-icons">${tokenIconHtml(bt)}${tokenIconHtml(qt)}</span>
        <span class="pair-name">${esc(bt.symbol)} / ${esc(qt.symbol)}</span>
      </td>
      <td class="mono">${formatUnits(rB, bt.decimals, 2)} ${esc(bt.symbol)} · ${formatUnits(rQ, qt.decimals, 2)} ${esc(qt.symbol)}</td>
      <td>${(p.feeBps / 100).toFixed(2)}%</td>
      <td>${p.swaps || 0}</td>
      <td class="mono">${tvl != null ? '$' + (tvl >= 1e6 ? (tvl / 1e6).toFixed(2) + 'M' : tvl.toFixed(0)) : '—'}</td>
      <td><button class="link link-danger" data-pool-del="${p.id}">Remove</button></td>`;
    body.appendChild(tr);
  }
  if (!state.pools.pools.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No pools yet — create one to start trading.</td></tr>`;
  }
}

function openCreatePool() {
  state.cp.a = state.swap.from;
  state.cp.b = state.swap.to;
  paintCpPick('a');
  paintCpPick('b');
  openModal('modal-create-pool');
}

function paintCpPick(which) {
  const id = state.cp[which];
  const t = tokenById(id) || { id, symbol: symbolOf(id) };
  el(`cp-${which}-sym`).textContent = symbolOf(id);
  el(`cp-${which}-icon`).innerHTML = tokenIconHtml(t);
  el(`cp-${which}-amt-label`).textContent = `Amount ${symbolOf(id)}`;
}

function createPoolGo() {
  const a = state.cp.a, b = state.cp.b;
  const amtA = el('cp-a-amt').value.trim();
  const amtB = el('cp-b-amt').value.trim();
  if (a === b) return toast('Pick two different tokens', 'error');
  try {
    const pool = state.pools.createPool(a, b, parseUnits(amtA, decimalsOf(a)), parseUnits(amtB, decimalsOf(b)));
    pushActivity({
      ts: Date.now(),
      kind: 'pool',
      text: `Created pool ${symbolOf(a)}/${symbolOf(b)}`,
      detail: `${formatUnits(BigInt(pool.rBase), decimalsOf(a), 2)} ${symbolOf(a)} / ${formatUnits(BigInt(pool.rQuote), decimalsOf(b), 2)} ${symbolOf(b)}`,
    });
    toast('Pool created (virtual liquidity)', 'ok');
    closeModal('modal-create-pool');
    renderPools();
    renderStats();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------------- activity ---------------- */
function pushActivity(entry) {
  state.pools.swapLog.unshift(entry);
  if (state.pools.swapLog.length > 100) state.pools.swapLog.length = 100;
  state.pools.save();
  renderActivity();
}

function renderActivity() {
  const list = el('activity-list');
  const entries = state.pools.swapLog;
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = `<div class="empty">No activity yet. Make a swap or send a transaction to see it here.</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'act-row';
    const when = new Date(e.ts).toLocaleString();
    row.innerHTML = `
      <span class="act-kind act-${esc(e.kind)}">${esc(e.kind)}</span>
      <div class="act-main">
        <div class="act-text">${esc(e.text)}</div>
        <div class="act-detail">${esc(e.detail || '')} · ${when}</div>
      </div>`;
    list.appendChild(row);
  }
}

/* ---------------- wallet ---------------- */
async function persistWallet(remembered) {
  if (remembered) {
    try {
      localStorage.setItem(CONFIG.storage.walletKey, JSON.stringify(state.walletRecord));
    } catch { /* ignore */ }
  } else {
    try { localStorage.removeItem(CONFIG.storage.walletKey); } catch { /* ignore */ }
  }
}

async function connectWallet(record, remembered) {
  state.walletRecord = { ...record, networkId: state.network, remembered };
  state.wallet = new Wallet(state.walletRecord);
  try {
    state.address = await state.wallet.getAddress();
  } catch (e) {
    toast(`Wallet error: ${e.message}`, 'error');
    state.wallet = null;
    return;
  }
  await persistWallet(remembered);
  await refreshBalances();
  renderWalletConnected();
  toast(`Wallet connected: ${shortAddr(state.address)}`, 'ok');
  closeModal('modal-wallet');
  updateSwapButtons();
}

function renderWalletConnected() {
  el('wallet-connected').hidden = false;
  el('wallet-connect').hidden = true;
  el('wallet-addr').textContent = state.address;
  el('wallet-net').textContent = CONFIG.networks[state.network].label;
  el('wallet-sub').textContent = state.walletRecord.type === 'mnemonic' ? 'mnemonic (BIP39 → sigma-rust master key)' : 'seed key (32 bytes)';
  el('btn-faucet').hidden = state.network !== 'testnet';
  el('wallet-storage-note').textContent = state.walletRecord.remembered
    ? 'Stored in this browser\'s localStorage. Anyone with this browser can open this wallet — use a burner for experiments.'
    : 'Memory only — this wallet will be lost when the tab closes.';
  renderWalletBalances();
}

function renderWalletBalances() {
  const box = el('wallet-balances');
  box.innerHTML = '';
  if (!state.balances) {
    box.innerHTML = `<div class="bal-none">Balances need a full node — set the Node URL in Settings (⚙).</div>`;
    return;
  }
  const erg = document.createElement('div');
  erg.className = 'bal';
  erg.innerHTML = `<span class="tk-c" style="--c:#ff7a1a">E</span><div><b class="mono">${formatUnits(state.balances.ergNano, 9, 4)}</b> <span>ERG</span></div>`;
  box.appendChild(erg);
  for (const [id, nano] of state.balances.tokens) {
    if (nano <= 0n) continue;
    const b = document.createElement('div');
    b.className = 'bal';
    b.innerHTML = `${tokenIconHtml(tokenById(id) || { id, symbol: symbolOf(id) })}<div><b class="mono">${formatUnits(nano, decimalsOf(id), 4)}</b> <span>${esc(symbolOf(id))}</span></div>`;
    box.appendChild(b);
  }
  renderBalancesRow();
}

async function refreshBalances() {
  state.balances = null;
  if (!state.wallet || !state.address || !state.api.nodeAvailable) {
    renderWalletBalances();
    renderBalancesRow();
    return;
  }
  try {
    const boxes = await state.api.unspent(state.address);
    let erg = 0n;
    const tokens = new Map();
    for (const b of boxes || []) {
      erg += jsonBigInt(b.value);
      for (const a of b.assets || []) {
        if (!a.tokenId) continue;
        const cur = tokens.get(a.tokenId) || 0n;
        tokens.set(a.tokenId, cur + jsonBigInt(a.amount));
        await ensureToken(a.tokenId).catch(() => {});
      }
    }
    state.balances = { ergNano: erg, tokens };
  } catch {
    state.balances = null;
    toast('Could not fetch balances (node unreachable?)', 'warn');
  }
  renderWalletBalances();
  renderBalancesRow();
}

function updateSwapButtons() {
  const label = el('connect-label');
  if (state.wallet && state.address) {
    label.textContent = shortAddr(state.address);
    el('btn-connect').classList.add('connected');
  } else {
    label.textContent = 'Connect Wallet';
    el('btn-connect').classList.remove('connected');
  }
  setSwapReady();
}

async function openSendModal() {
  el('send-token-sym').textContent = symbolOf(state.swap.from);
  el('send-token-icon').innerHTML = tokenIconHtml(tokenById(state.swap.from) || { id: state.swap.from, symbol: symbolOf(state.swap.from) });
  state.sendToken = state.swap.from;
  el('send-meta').textContent = '';
  openModal('modal-send');
}

async function sendGo() {
  const recipient = el('send-recipient').value.trim();
  const amount = el('send-amount').value.trim();
  if (!recipient || !amount) return toast('Fill recipient and amount', 'error');
  if (!state.api.nodeAvailable) return toast('Set a full node URL in Settings first', 'error');
  const btn = el('btn-send-go');
  btn.disabled = true;
  btn.textContent = 'Signing…';
  try {
    await ensureToken(state.sendToken);
    const tokenId = state.sendToken === 'ERG' ? null : state.sendToken;
    const amountNano = parseUnits(amount, decimalsOf(state.sendToken));
    const boxes = await state.api.unspent(state.address);
    if (!boxes || !boxes.length) throw new Error('No unspent boxes for this wallet');
    const headers = await state.api.recentHeaders(10); // newest first, tip at index 0
    const txJson = await state.wallet.buildSignedTx({
      boxesJson: boxes,
      recipient,
      amountNano: amountNano.toString(),
      tokenId,
      height: headers[0].height,
      headersJson: headers,
    });
    btn.textContent = 'Broadcasting…';
    const res = await state.api.broadcast(txJson);
    const txId = typeof res === 'string' ? res : (res && res.id) || 'sent';
    pushActivity({
      ts: Date.now(),
      kind: 'send',
      text: `Sent ${formatUnits(amountNano, decimalsOf(state.sendToken), 4)} ${symbolOf(state.sendToken)} → ${shortAddr(recipient)}`,
      detail: `tx ${txId} · broadcast via ${state.api.nodeUrl}`,
    });
    toast(`Transaction broadcast: ${txId}`, 'ok', 6000);
    closeModal('modal-send');
    await refreshBalances();
  } catch (e) {
    toast(`Send failed: ${e.message}`, 'error', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign & broadcast';
  }
}

async function faucetGo() {
  if (!state.api.nodeAvailable) return toast('Faucet needs a full node (testnet node) URL', 'error');
  try {
    const res = await state.api.faucet(state.address);
    pushActivity({ ts: Date.now(), kind: 'faucet', text: 'Requested testnet faucet', detail: String(res).slice(0, 120) });
    toast('Faucet request registered — check your node logs / mempool', 'ok', 6000);
  } catch (e) {
    toast(`Faucet failed: ${e.message}`, 'error');
  }
}

async function signCheck() {
  const msg = `EUTXO.DEX key check ${Date.now()}`;
  try {
    const sig = await state.wallet.signMessage(msg);
    toast(`Key OK — signed message (sig ${sig.slice(0, 12)}…${sig.slice(-6)})`, 'ok', 6000);
  } catch (e) {
    toast(`Sign check failed: ${e.message}`, 'error');
  }
}

function disconnectWallet() {
  state.wallet = null;
  state.walletRecord = null;
  state.address = null;
  state.balances = null;
  el('wallet-connected').hidden = true;
  el('wallet-connect').hidden = false;
  el('bal-from').textContent = 'connect';
  updateSwapButtons();
  toast('Wallet disconnected (local copy wiped)', 'info');
}

/* ---------------- token select modal ---------------- */
function openTokenSelect(forWhat) {
  state.tokenSelectFor = forWhat;
  el('ts-title').textContent = {
    'swap-from': 'Select token to sell',
    'swap-to': 'Select token to buy',
    send: 'Select asset to send',
    'cp-a': 'Select Token A',
    'cp-b': 'Select Token B',
  }[forWhat] || 'Select token';
  el('ts-search').value = '';
  state.tsQuery = '';
  renderTokenSelect();
  openModal('modal-token-select');
  setTimeout(() => el('ts-search').focus(), 50);
}

function renderTokenSelect() {
  const list = el('ts-list');
  list.innerHTML = '';
  const q = state.tsQuery.toLowerCase();
  const rows = state.tokens
    .filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.id.includes(q) || (t.name || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const d = Number(!!b.active) - Number(!!a.active); // active first
      if (d !== 0) return d;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, 80);
  for (const t of rows) {
    const row = document.createElement('div');
    row.className = 'ts-row';
    row.innerHTML = `
      <span class="ts-icon">${tokenIconHtml(t)}</span>
      <div class="ts-main"><b>${esc(t.symbol)}</b>${t.name && t.name !== t.symbol ? `<small>${esc(t.name)}</small>` : ''}</div>
      ${t.active ? '<span class="ts-dot" title="Active in recent blocks"></span>' : ''}
      <span class="ts-id mono">${t.id === 'ERG' ? 'native' : t.id.slice(0, 10) + '…'}</span>`;
    row.addEventListener('click', () => selectToken(t.id));
    list.appendChild(row);
  }
  if (!rows.length) list.innerHTML = `<div class="empty">No tokens match.</div>`;
}

function selectToken(id) {
  const forWhat = state.tokenSelectFor;
  if (forWhat === 'swap-from') {
    if (id === state.swap.to) return toast('Choose different tokens', 'warn');
    state.swap.from = id;
  } else if (forWhat === 'swap-to') {
    if (id === state.swap.from) return toast('Choose different tokens', 'warn');
    state.swap.to = id;
  } else if (forWhat === 'send') {
    state.sendToken = id;
    el('send-token-sym').textContent = symbolOf(id);
    el('send-token-icon').innerHTML = tokenIconHtml(tokenById(id) || { id, symbol: symbolOf(id) });
  } else if (forWhat === 'cp-a') {
    state.cp.a = id;
    paintCpPick('a');
  } else if (forWhat === 'cp-b') {
    state.cp.b = id;
    paintCpPick('b');
  }
  closeModal('modal-token-select');
  if (forWhat === 'swap-from' || forWhat === 'swap-to') {
    renderSwapHead();
    updateQuote();
  }
  renderTokenSelect();
}

/* ---------------- modals ---------------- */
function openModal(id) {
  const m = el(id);
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('open'));
}
function closeModal(id) {
  const m = el(id);
  m.classList.remove('open');
  setTimeout(() => { m.hidden = true; }, 160);
}

/* ---------------- tabs ---------------- */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  if (tab === 'pools') renderPools();
  if (tab === 'activity') renderActivity();
}

/* ---------------- network / settings ---------------- */
function applyNetwork(netId) {
  state.network = netId;
  state.api = new ErgoApi(netId, { nodeUrl: state.settings.nodeUrl });
  state.chain = null;
  setNetBadge(false);
  el('stat-height').textContent = '…';
  refreshChain();
  refreshGatewayTokens().then(() => {
    renderSwapHead();
    updateQuote();
  });
  if (state.wallet && state.walletRecord) {
    state.wallet.networkId = netId;
    state.walletRecord.networkId = netId;
    state.wallet.getAddress().then((a) => {
      state.address = a;
      renderWalletConnected();
      refreshBalances();
    }).catch(() => {});
  }
}

async function saveSettings() {
  const nodeUrl = el('set-node-url').value.trim().replace(/\/+$/, '');
  state.settings.nodeUrl = nodeUrl;
  try { localStorage.setItem(CONFIG.storage.settingsKey, JSON.stringify(state.settings)); } catch { /* ignore */ }
  state.api = new ErgoApi(state.network, { nodeUrl });
  if (state.wallet) await refreshBalances();
  toast('Settings saved', 'ok');
}

async function testNode() {
  const url = el('set-node-url').value.trim().replace(/\/+$/, '');
  const box = el('node-status');
  if (!url) { box.textContent = 'No node URL'; box.className = 'node-status'; return; }
  box.textContent = 'Testing…';
  box.className = 'node-status';
  const api = new ErgoApi(state.network, { nodeUrl: url });
  try {
    const info = await api.nodeInfo();
    const h = info && info.blockchainHeight;
    box.textContent = `✓ node OK${h ? ` · height ${h}` : ''}`;
    box.className = 'node-status ok';
  } catch (e) {
    box.textContent = `✗ ${e.message}`;
    box.className = 'node-status bad';
  }
}

/* ---------------- init ---------------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(CONFIG.storage.settingsKey);
    if (raw) state.settings = { ...state.settings, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  el('set-node-url').value = state.settings.nodeUrl;
}

async function restoreWallet() {
  try {
    const raw = localStorage.getItem(CONFIG.storage.walletKey);
    if (!raw) return;
    const rec = JSON.parse(raw);
    if (rec && rec.value) await connectWallet({ type: rec.type, value: rec.value }, rec.remembered !== false);
  } catch { /* ignore */ }
}

function bindEvents() {
  // tabs
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // header
  el('btn-connect').addEventListener('click', () => {
    if (state.wallet) { renderWalletConnected(); openModal('modal-wallet'); }
    else openModal('modal-wallet');
  });
  el('btn-settings').addEventListener('click', () => openModal('modal-settings'));

  // swap
  el('amt-from').addEventListener('input', updateQuote);
  el('amt-from').addEventListener('blur', () => {
    const v = el('amt-from').value.trim();
    if (!v) return;
    try { el('amt-from').value = formatUnits(parseUnits(v, decimalsOf(state.swap.from)), decimalsOf(state.swap.from), 9); } catch { /* keep */ }
  });
  el('btn-flip').addEventListener('click', () => {
    const f = state.swap.from;
    state.swap.from = state.swap.to;
    state.swap.to = f;
    el('amt-from').value = '';
    renderSwapHead();
    updateQuote();
  });
  el('pick-from').addEventListener('click', () => openTokenSelect('swap-from'));
  el('pick-to').addEventListener('click', () => openTokenSelect('swap-to'));
  el('btn-max').addEventListener('click', () => {
    if (!state.balances) return toast('Balances unavailable — needs a full node', 'warn');
    const id = state.swap.from;
    const nano = id === 'ERG' ? state.balances.ergNano : (state.balances.tokens.get(id) || 0n);
    if (nano <= 0n) return toast('Zero balance for this token', 'warn');
    el('amt-from').value = formatUnits(nano, decimalsOf(id), 9);
    updateQuote();
  });
  el('btn-swap').addEventListener('click', doSwap);
  el('btn-slippage').addEventListener('click', () => {
    const opts = CONFIG.ui.slippageOptions;
    const i = opts.indexOf(state.swap.slippage);
    state.swap.slippage = opts[(i + 1) % opts.length];
    el('slippage-val').textContent = `${state.swap.slippage}%`;
    updateQuote();
  });

  // pools
  el('btn-create-pool').addEventListener('click', openCreatePool);
  el('btn-reset-pools').addEventListener('click', () => {
    if (!confirm('Reset all pools to the demo seed?')) return;
    state.pools.reset();
    pushActivity({ ts: Date.now(), kind: 'pool', text: 'Pools reset to demo seed', detail: 'local state' });
    renderPools();
    renderStats();
    toast('Pools reset', 'ok');
  });
  el('pools-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pool-del]');
    if (!btn) return;
    state.pools.removePool(btn.dataset.poolDel);
    pushActivity({ ts: Date.now(), kind: 'pool', text: 'Removed pool', detail: btn.dataset.poolDel });
    renderPools();
    renderStats();
    updateQuote();
  });

  // create pool
  el('btn-cp-go').addEventListener('click', createPoolGo);
  el('cp-a-pick').addEventListener('click', () => openTokenSelect('cp-a'));
  el('cp-b-pick').addEventListener('click', () => openTokenSelect('cp-b'));

  // activity
  el('btn-clear-activity').addEventListener('click', () => {
    state.pools.swapLog = [];
    state.pools.save();
    renderActivity();
  });

  // wallet modal
  el('wc-create').addEventListener('click', () => {
    el('wc-form-label').textContent = 'New wallet (seed generated on this device)';
    el('wc-input').value = createSeedHex();
    el('wc-input').readOnly = true;
    el('wc-input').rows = 2;
    el('wc-form').hidden = false;
    el('wc-msg').textContent = 'A fresh 32-byte seed (64 hex chars) was generated with crypto.getRandomValues(). Copy it somewhere safe — it is the only key to this wallet.';
    el('wc-go').dataset.mode = 'seed';
  });
  el('wc-import-mnemonic').addEventListener('click', () => {
    el('wc-form-label').textContent = 'Mnemonic (12 or 24 words)';
    el('wc-input').value = '';
    el('wc-input').readOnly = false;
    el('wc-input').rows = 3;
    el('wc-form').hidden = false;
    el('wc-msg').textContent = '';
    el('wc-go').dataset.mode = 'mnemonic';
  });
  el('wc-import-seed').addEventListener('click', () => {
    el('wc-form-label').textContent = 'Seed key (64 hex chars)';
    el('wc-input').value = '';
    el('wc-input').readOnly = false;
    el('wc-input').rows = 2;
    el('wc-form').hidden = false;
    el('wc-msg').textContent = '';
    el('wc-go').dataset.mode = 'seed';
  });
  el('wc-extension').addEventListener('click', async () => {
    const ext = await detectExtension();
    if (!ext) { el('wc-msg').textContent = 'No Ergo extension detected (window.ergo not found). Install the Ergo wallet extension to use it.'; return; }
    el('wc-msg').textContent = ext.accounts.length
      ? `Extension accounts: ${ext.accounts.join(', ')}`
      : 'Extension found but no accounts exposed yet.';
  });
  el('wc-cancel').addEventListener('click', () => { el('wc-form').hidden = true; el('wc-msg').textContent = ''; });
  el('wc-go').addEventListener('click', async () => {
    const mode = el('wc-go').dataset.mode;
    const value = el('wc-input').value.trim();
    const remembered = el('wc-remember').checked;
    const msg = el('wc-msg');
    msg.textContent = 'Checking…';
    try {
      if (mode === 'mnemonic') await validateMnemonic(value, state.network);
      else await validateSeed(value, state.network);
      await connectWallet({ type: mode === 'mnemonic' ? 'mnemonic' : 'seed', value }, remembered);
    } catch (e) {
      msg.textContent = e.message;
    }
  });

  el('btn-disconnect').addEventListener('click', () => {
    try { localStorage.removeItem(CONFIG.storage.walletKey); } catch { /* ignore */ }
    disconnectWallet();
  });
  el('btn-copy-addr').addEventListener('click', () => copyText(state.address));
  el('btn-open-send').addEventListener('click', openSendModal);
  el('btn-faucet').addEventListener('click', faucetGo);
  el('btn-sign-check').addEventListener('click', signCheck);

  // send modal
  el('send-token-pick').addEventListener('click', () => openTokenSelect('send'));
  el('btn-send-go').addEventListener('click', sendGo);

  // settings
  el('btn-settings-save').addEventListener('click', async () => {
    await saveSettings();
    await testNode();
  });
  el('set-node-url').addEventListener('change', testNode);
  el('seg-network').addEventListener('click', (e) => {
    const b = e.target.closest('[data-net]');
    if (!b) return;
    document.querySelectorAll('#seg-network [data-net]').forEach((x) => x.classList.toggle('on', x === b));
    applyNetwork(b.dataset.net);
    toast(`Network: ${b.dataset.net}`, 'info');
  });
  el('btn-wipe-wallet').addEventListener('click', () => {
    if (!confirm('Wipe the locally stored wallet from this browser?')) return;
    try { localStorage.removeItem(CONFIG.storage.walletKey); } catch { /* ignore */ }
    disconnectWallet();
    closeModal('modal-settings');
  });

  // token select
  el('ts-search').addEventListener('input', () => { state.tsQuery = el('ts-search').value.trim(); renderTokenSelect(); });

  // modals: backdrop + esc + data-close
  document.querySelectorAll('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m.id); });
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = b.closest('.modal-backdrop');
      if (m) closeModal(m.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const m of document.querySelectorAll('.modal-backdrop:not([hidden])')) closeModal(m.id);
    }
  });

  // donation copy
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy)));
}

/* ---------------- boot ---------------- */
async function boot() {
  el('foot-ver').textContent = `v${CONFIG.app.version}`;
  el('ver-num').textContent = CONFIG.app.version;
  seedTokens();
  loadSettings();
  state.api = new ErgoApi(state.network, { nodeUrl: state.settings.nodeUrl });
  bindEvents();
  renderSwapHead();
  renderPools();
  renderStats();
  renderActivity();
  updateQuote();
  updateSwapButtons();

  await Promise.allSettled([
    (async () => {
      await loadErgoLib();
      toast('sigma-rust engine ready (ergo-lib-wasm)', 'ok', 3500);
    })(),
    refreshChain(),
    refreshPrice(),
    refreshGatewayTokens().then(() => { renderSwapHead(); updateQuote(); }),
    restoreWallet(),
  ]);

  refreshActivity().catch(() => {});
  setInterval(() => { if (!document.hidden) refreshChain().catch(() => {}); }, 30000);
  setInterval(() => { if (!document.hidden) refreshPrice().catch(() => {}); }, CONFIG.price.refreshMs);
  setInterval(() => { if (!document.hidden) refreshActivity().catch(() => {}); }, 20 * 60 * 1000);
}

boot().catch((e) => {
  console.error(e);
  toast(`Boot error: ${e.message}`, 'error', 8000);
});
