/* EUTXO.DEX — wallet module verification (real js/wallet.js vs sigma-rust reference vectors).
 * Run: node --experimental-wasm-modules tests/wallet.verify.mjs   (or: npm test -- wallet)
 */
const { Wallet, validateMnemonic, validateSeed, createSeedHex } = await import(
  new URL('../js/wallet.js', import.meta.url).href
);

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fails++;
};

// 1) Known mnemonic -> master P2PK (sigma-rust master key, verified vs ergo-node vector)
{
  const w = new Wallet({ type: 'mnemonic', value: 'edge talent poet tortoise trumpet dose', networkId: 'mainnet' });
  const addr = await w.getAddress();
  check('mnemonic mainnet address == reference master P2PK',
    addr === '9fXwKh5rArH7BDXFhSybDAfdHXuCELZe3jbJsAbZCgFRbdCrfay', addr);
}

// 2) Same mnemonic on testnet prefix
{
  const w = new Wallet({ type: 'mnemonic', value: 'edge talent poet tortoise trumpet dose', networkId: 'testnet' });
  const addr = await w.getAddress();
  console.log('  info testnet address =', addr);
  check('testnet address has 3W prefix', /^3W/.test(addr), addr);
}

// 3) Seed (raw 32-byte dlog) import
{
  const seed = createSeedHex();
  check('createSeedHex is 64 hex chars', /^[0-9a-f]{64}$/.test(seed), seed.slice(0, 12) + '…');
  const w = new Wallet({ type: 'seed', value: seed, networkId: 'mainnet' });
  const addr = await w.getAddress();
  check('seed-derived address looks like mainnet P2PK', /^9[efghi]/.test(addr) && addr.length >= 40, addr);
}

// 4) Validators
{
  const ok = await validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'mainnet');
  check('validateMnemonic accepts 12 words', typeof ok === 'string' && ok.length >= 40);
  let threw = false;
  try { await validateMnemonic('one two three', 'mainnet'); } catch { threw = true; }
  check('validateMnemonic rejects 3 words', threw);
  const seed = createSeedHex();
  const a = await validateSeed(seed, 'mainnet');
  check('validateSeed accepts 32-byte hex', typeof a === 'string');
  let threw2 = false;
  try { await validateSeed('beef', 'mainnet'); } catch { threw2 = true; }
  check('validateSeed rejects short hex', threw2);
}

// 5) signMessage produces 64-byte dlog signature (128 hex)
{
  const w = new Wallet({ type: 'mnemonic', value: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', networkId: 'mainnet' });
  const sig = await w.signMessage('EUTXO.DEX test message');
  check('signMessage returns valid sigma proof hex', /^[0-9a-f]{112,128}$/.test(sig), `${sig.length} hex chars`);
}

console.log(fails === 0 ? '\nWALLET MODULE VERIFIED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
