/* EUTXO.DEX — AMM engine test suite.
 * Run: node tests/amm.test.mjs   (or: npm test -- amm)
 */
import { PoolEngine, parseUnits, formatUnits } from '../js/amm.js';

let fails = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fails++; console.log(` FAIL ${name} ${extra}`); }
}

// parse/format
check('parseUnits 1.5 @9', parseUnits('1.5', 9) === 1500000000n, String(parseUnits('1.5', 9)));
check('parseUnits 0 @8', parseUnits('0', 8) === 0n);
check('parseUnits int', parseUnits('7', 6) === 7000000n);
check('parseUnits rejects >decimals', (() => { try { parseUnits('1.123456789', 6); return false; } catch { return true; } })());
check('formatUnits roundtrip', formatUnits(1500000000n, 9) === '1.5', formatUnits(1500000000n, 9));
check('formatUnits zero', formatUnits(0n, 8) === '0');
check('formatUnits tiny', formatUnits(1n, 9) === '0.000000001');

// pool engine
const eng = new PoolEngine();
check('seed pools exist', eng.pools.length >= 2, String(eng.pools.length));
const p = eng.getPool('ERG', 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7');
check('seed pool found', !!p);
if (p) {
  const inNano = 100n * 10n ** 9n; // 100 ERG
  const q = eng.quote(p, 'ERG', inNano, 0.5);
  const rBase = BigInt(p.rBase);   // 20000 ERG
  const rQuote = BigInt(p.rQuote); // 20000 LIT (decimals 9)
  const expectedOut = (rQuote * (inNano - (inNano * 30n) / 10000n)) / (rBase + (inNano - (inNano * 30n) / 10000n));
  check('quote out matches formula', q.outAmount === expectedOut, `${q.outAmount} vs ${expectedOut}`);
  const spot = (rQuote * (inNano - (inNano * 30n) / 10000n)) / rBase;
  check('spot >= out', spot >= q.outAmount);
  check('impact bps sane', q.priceImpactBps > 0n && q.priceImpactBps < 500n, q.priceImpactBps.toString());
  check('minOut < out', q.minOut < q.outAmount && q.minOut > 0n);

  // reverse quote (LIT -> ERG)
  const in2 = 50n * 10n ** 9n;
  const q2 = eng.quote(p, 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7', in2, 1);
  check('reverse quote positive', q2.outAmount > 0n);

  // apply swap changes reserves
  const before = BigInt(p.rBase);
  eng.applySwap(p, 'ERG', q);
  check('reserveBase grew', BigInt(p.rBase) > before, `${p.rBase} vs ${before}`);
  check('reserveQuote shrank', BigInt(p.rQuote) < rQuote);
  check('pool swaps counted', p.swaps === 1);

  // conservation: fee captured, out paid from reserves
  const fee = (q.inAmount * 30n) / 10000n;
  check('base reserve delta = in - fee', BigInt(p.rBase) - before === q.inAmount - fee);
}

// pool create/remove
const eng2 = new PoolEngine();
const np = eng2.createPool('a', 'b', 10n ** 9n, 5n * 10n ** 9n);
check('create pool', eng2.getPool('a', 'b') === np);
check('create duplicate throws', (() => { try { eng2.createPool('b', 'a', 1n, 1n); return false; } catch { return true; } })());
eng2.removePool(np.id);
check('remove pool', eng2.getPool('a', 'b') === null);

// same-pair lookup is order independent
const eng3 = new PoolEngine();
eng3.createPool('X', 'Y', 1n, 1n);
check('order-independent getPool', !!eng3.getPool('Y', 'X'));

console.log(fails === 0 ? '\nALL TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
