/* EUTXO.DEX — AMM pool engine (constant-product, BigInt-safe).
 *
 * Pools hold reserves for two tokens (ERG = native coin, others = Ergo token ids).
 * Quotes are real constant-product math with fee + price-impact; swap "settlement"
 * updates reserves locally (virtual liquidity). See README for the on-chain roadmap.
 */
import { CONFIG } from './config.js';

const ONE = 10n ** 9n; // nano units per whole ERG

function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`Bad amount: ${v}`);
  return BigInt(s);
}

/** Parse a decimal string (e.g. "1.5") into nano units using `decimals`. */
export function parseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!s || !/^\d*\.?\d*$/.test(s) || s === '.') throw new Error('Invalid amount');
  const neg = s.startsWith('-');
  const clean = s.replace('-', '');
  const [whole, frac = ''] = clean.split('.');
  if (frac.length > decimals) throw new Error(`Too many decimals (max ${decimals})`);
  const nano = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac || '0').padEnd(decimals, '0'));
  return neg ? -nano : nano;
}

/** Format nano units back to a human string, trimming trailing zeros. */
export function formatUnits(nano, decimals, maxFrac = 6) {
  const neg = nano < 0n;
  let n = neg ? -nano : nano;
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  let frac = (n % base).toString().padStart(decimals, '0');
  if (whole > 0n && frac.length > maxFrac) frac = frac.slice(0, maxFrac);
  // Sub-1 amounts keep full precision so tiny values don't display as "0".
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function shortAmount(nano, decimals, maxFrac = 4) {
  const v = formatUnits(nano, decimals, maxFrac);
  const [w, f] = v.split('.');
  const n = Number(w);
  if (!isFinite(n)) return v;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B${f ? '.' + f.slice(0, 2) : ''}`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M${f ? '.' + f.slice(0, 2) : ''}`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K${f ? '.' + f.slice(0, 2) : ''}`;
  return v;
}

export class PoolEngine {
  constructor() {
    this.pools = [];
    this.swapLog = [];
    this.load();
  }

  key(baseId, quoteId) {
    return [baseId, quoteId].sort().join('|');
  }

  getPool(baseId, quoteId) {
    const k = this.key(baseId, quoteId);
    return this.pools.find((p) => this.key(p.base, p.quote) === k) || null;
  }

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.storage.poolsKey);
      if (raw) {
        const j = JSON.parse(raw);
        this.pools = (j.pools || []).map((p) => ({ ...p, rBase: p.rBase, rQuote: p.rQuote }));
        this.swapLog = j.swapLog || [];
        return;
      }
    } catch { /* fall through to seeds */ }
    this.seed();
  }

  seed() {
    this.pools = CONFIG.defaultPools.map((d, i) => ({
      id: `seed-${i}`,
      base: d.base,
      quote: d.quote,
      rBase: d.rBase,
      rQuote: d.rQuote,
      feeBps: d.feeBps || 30,
      created: Date.now(),
      volumeBase: '0',
      volumeQuote: '0',
      swaps: 0,
    }));
    this.swapLog = [];
    this.save();
  }

  reset() {
    this.pools = [];
    this.swapLog = [];
    this.seed();
  }

  save() {
    try {
      localStorage.setItem(CONFIG.storage.poolsKey, JSON.stringify({ pools: this.pools, swapLog: this.swapLog.slice(0, 100) }));
    } catch { /* storage full/blocked — non-fatal */ }
  }

  createPool(baseId, quoteId, amountBase, amountQuote, feeBps = 30) {
    if (baseId === quoteId) throw new Error('Pick two different tokens');
    if (this.getPool(baseId, quoteId)) throw new Error('Pool already exists');
    const pool = {
      id: `p-${Date.now().toString(36)}`,
      base: baseId,
      quote: quoteId,
      rBase: amountBase.toString(),
      rQuote: amountQuote.toString(),
      feeBps,
      created: Date.now(),
      volumeBase: '0',
      volumeQuote: '0',
      swaps: 0,
    };
    this.pools.push(pool);
    this.save();
    return pool;
  }

  removePool(id) {
    this.pools = this.pools.filter((p) => p.id !== id);
    this.save();
  }

  /**
   * Quote a swap.
   * @returns {{inAmount:bigint, fee:bigint, outAmount:bigint, spotOut:bigint, priceImpactBps:bigint, rate:string|null}}
   */
  quote(pool, inTokenId, inNano, slippagePct) {
    const inBase = inTokenId === pool.base;
    const rIn = toBig(inBase ? pool.rBase : pool.rQuote);
    const rOut = toBig(inBase ? pool.rQuote : pool.rBase);
    if (rIn === 0n || rOut === 0n) throw new Error('Pool has no liquidity');
    const fee = (inNano * BigInt(pool.feeBps)) / 10000n;
    const inAfter = inNano - fee;
    if (inAfter <= 0n) throw new Error('Amount too small');
    const out = (rOut * inAfter) / (rIn + inAfter);
    const spotOut = (rOut * inAfter) / rIn;
    if (out <= 0n) throw new Error('Amount too small');
    // price impact in basis points: (spot - out)/spot * 10000
    const impactBps = spotOut > 0n ? ((spotOut - out) * 10000n) / spotOut : 0n;
    const minOut = out - (out * BigInt(Math.round(slippagePct * 100))) / 10000n;
    return { inAmount: inNano, fee, outAmount: out, spotOut, priceImpactBps: impactBps, minOut: minOut < 0n ? 0n : minOut };
  }

  /** Apply a swap to pool reserves (virtual settlement). */
  applySwap(pool, inTokenId, q) {
    const inBase = inTokenId === pool.base;
    const fee = (q.inAmount * BigInt(pool.feeBps)) / 10000n;
    const inAfter = q.inAmount - fee;
    if (inBase) {
      pool.rBase = (toBig(pool.rBase) + inAfter).toString();
      pool.rQuote = (toBig(pool.rQuote) - q.outAmount).toString();
      pool.volumeBase = (toBig(pool.volumeBase) + q.inAmount).toString();
      pool.volumeQuote = (toBig(pool.volumeQuote) + q.outAmount).toString();
    } else {
      pool.rQuote = (toBig(pool.rQuote) + inAfter).toString();
      pool.rBase = (toBig(pool.rBase) - q.outAmount).toString();
      pool.volumeQuote = (toBig(pool.volumeQuote) + q.inAmount).toString();
      pool.volumeBase = (toBig(pool.volumeBase) + q.outAmount).toString();
    }
    pool.swaps = (pool.swaps || 0) + 1;
    this.save();
  }

  /** USD value of reserves given an ERG->USD price (non-ERG priced at ERG parity 1:1 estimate). */
  tvlUsd(ergUsd) {
    if (!ergUsd) return null;
    let total = 0n;
    for (const p of this.pools) {
      const bNative = p.base === 'ERG';
      const qNative = p.quote === 'ERG';
      // nanoERG equivalent: native reserves as-is; token reserves treated as 1:1 vs ERG (estimate)
      const nanoErg = toBig(p.rBase) + toBig(p.rQuote) - (bNative ? 0n : toBig(p.rBase)) - (qNative ? 0n : toBig(p.rQuote));
      const tokenNano = (bNative ? 0n : toBig(p.rBase)) + (qNative ? 0n : toBig(p.rQuote));
      total += nanoErg + tokenNano; // rough: token units ~ ERG units estimate
    }
    return Number(total) / 1e9 * ergUsd;
  }
}

export const AMM = { PoolEngine, parseUnits, formatUnits, shortAmount };
