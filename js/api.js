/* EUTXO.DEX — Ergo network API client.
 *
 * Two layers:
 *  1) Public gateway (verified CORS-open): chain info, tokens, blocks.
 *     https://api.ergoplatform.com/api/v1/{info|tokens|tokens/{id}|blocks|blocks/{id}}
 *  2) Optional full node (user-configurable): unspent boxes, tip header,
 *     tx broadcast, testnet faucet.
 */
import { CONFIG } from './config.js';

const DEFAULT_TIMEOUT = 15000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class ErgoApi {
  /**
   * @param {string} networkId 'mainnet' | 'testnet'
   * @param {{nodeUrl?: string, onEvent?: (e)=>void}} [opts]
   */
  constructor(networkId, opts = {}) {
    const net = CONFIG.networks[networkId] || CONFIG.networks.mainnet;
    this.networkId = net.id;
    this.net = net;
    this.gateway = net.gateway;
    this.nodeUrl = (opts.nodeUrl || '').replace(/\/+$/, '');
    this.onEvent = opts.onEvent || (() => {});
  }

  async fetchJson(url, { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body: body != null ? JSON.stringify(body) : undefined,
        headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        throw new ApiError(`${method} ${new URL(url).pathname} -> ${res.status}`, res.status);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError(`Timeout: ${url}`, 408);
      if (e instanceof ApiError) throw e;
      throw new ApiError(`Network error: ${e.message || e}`, 0);
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- gateway (public, no node required) ----------

  info() { return this.fetchJson(`${this.gateway}/info`); }

  tokens(limit = 100, offset = 0) {
    return this.fetchJson(`${this.gateway}/tokens?limit=${limit}&offset=${offset}`);
  }

  token(id) { return this.fetchJson(`${this.gateway}/tokens/${id}`); }

  blocks(limit = 10) { return this.fetchJson(`${this.gateway}/blocks?limit=${limit}`); }

  block(id) { return this.fetchJson(`${this.gateway}/blocks/${id}`); }

  /** Scan recent blocks and return token-id -> occurrence count (activity score). */
  async tokenActivity(blockCount = CONFIG.ui.activityBlocks) {
    const list = await this.blocks(blockCount);
    const items = (list && list.items) || (Array.isArray(list) ? list : []);
    const scores = new Map();
    let scanned = 0;
    const chunks = [];
    for (let i = 0; i < items.length; i += 6) chunks.push(items.slice(i, i + 6));
    for (const chunk of chunks) {
      const results = await Promise.allSettled(chunk.map((b) => this.block(b.id)));
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        scanned++;
        const txs = (r.value && r.value.block && r.value.block.transactions) || [];
        for (const tx of txs) {
          for (const out of tx.outputs || []) {
            for (const a of out.assets || []) {
              const id = a.tokenId;
              if (!id) continue;
              scores.set(id, (scores.get(id) || 0) + 1);
            }
          }
        }
      }
    }
    const arr = [...scores.entries()].map(([id, count]) => ({ id, count }));
    arr.sort((a, b) => b.count - a.count);
    return { scores: arr, scanned };
  }

  // ---------- optional full node ----------

  get nodeAvailable() { return !!this.nodeUrl; }

  nodeInfo() { return this.fetchJson(`${this.nodeUrl}/info`, { timeout: 6000 }); }

  unspent(address) { return this.fetchJson(`${this.nodeUrl}/addresses/${address}/unspent`); }

  tipHeader() { return this.fetchJson(`${this.nodeUrl}/blocks/tip`); }

  /**
   * Last `count` block headers, newest first (tip at index 0).
   * sigma-rust's ErgoStateContext requires exactly the last 10 headers.
   * Prefers the public gateway (CORS-open); falls back to walking the
   * chain backwards from the tip on a configured full node.
   */
  async recentHeaders(count = 10) {
    try {
      const list = await this.blocks(count);
      const items = (list && list.items) || (Array.isArray(list) ? list : []);
      if (items.length >= count) {
        // List endpoint returns summaries only — fetch full headers by id (newest first).
        const results = await Promise.all(items.slice(0, count).map((b) => this.block(b.id)));
        const headers = results.map((r) => (r && r.block && r.block.header) || null).filter(Boolean);
        if (headers.length >= count) return headers;
      }
    } catch (e) { /* fall back to node below */ }
    if (!this.nodeAvailable) {
      throw new ApiError('Could not fetch the last 10 block headers (gateway unreachable and no full node configured)', 0);
    }
    const out = [];
    let cur = await this.fetchJson(`${this.nodeUrl}/blocks/tip`);
    while (cur && out.length < count) {
      const h = cur.header || cur;
      out.push(h);
      const prev = h && h.previousBlock;
      cur = prev ? await this.fetchJson(`${this.nodeUrl}/blocks/${prev}`) : null;
    }
    if (out.length < count) throw new ApiError(`Only ${out.length} block headers available (need ${count})`, 0);
    return out;
  }

  async broadcast(txJson) {
    const url = `${this.nodeUrl}/transactions`;
    const body = typeof txJson === 'string' ? txJson : JSON.stringify(txJson);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      if (!res.ok) throw new ApiError(`broadcast -> ${res.status}: ${String(data).slice(0, 200)}`, res.status);
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  faucet(address) {
    return this.fetchJson(`${this.nodeUrl}/faucet`, { method: 'POST', body: { address }, timeout: 20000 });
  }
}

/* ---------- USD price (CoinGecko, CORS-open) ---------- */
export async function getErgoUsdPrice() {
  try {
    const res = await fetch(`${CONFIG.price.coingecko}?ids=ergo&vs_currencies=usd`);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ergo ? Number(j.ergo.usd) : null;
  } catch {
    return null;
  }
}
