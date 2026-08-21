/* EUTXO.DEX — full buildSignedTx verification: real sigma-rust prover + real mainnet tip.
 * The spending proofs are verified with sigma-rust's OWN verifier (verify_tx_input_proof).
 * Run: node --experimental-wasm-modules tests/sign.verify.mjs   (or: npm test -- sign)
 */
import * as crypto from 'node:crypto';

const { Wallet, loadErgoLib } = await import(new URL('../js/wallet.js', import.meta.url).href);
const E = await loadErgoLib();

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok ' : 'FAIL'} ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fails++;
};

// base58 decode with checksum
function b58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

// pubkey (33 bytes) from a P2PK address
// layout (sigma-rust AddressEncoder): [headByte = networkPrefix + typePrefix (1B)] [content (33B)] [checksum (4B)]
function pubkeyFromAddress(addr) {
  const raw = b58decode(addr); // 38 bytes for P2PK (checksum is blake2b-256; addresses here come from sigma-rust itself)
  if (raw.length !== 38) throw new Error('bad address length ' + raw.length);
  if (raw[0] !== 0x01) throw new Error('not a mainnet P2PK: ' + raw[0].toString(16));
  return raw.subarray(1, 34);
}

// real mainnet headers — last 10, newest first (required by ErgoStateContext)
const blockList = await (await fetch('https://api.ergoplatform.com/api/v1/blocks?limit=10')).json();
const blockIds = blockList.items.map((b) => b.id);
const fullBlocks = await Promise.all(blockIds.map((id) => fetch(`https://api.ergoplatform.com/api/v1/blocks/${id}`).then((r) => r.json())));
const headers10 = fullBlocks.map((b) => b.block.header);
check('10 headers, newest first', headers10.length === 10 && headers10[0].height > headers10[9].height, `h0=${headers10[0].height} h9=${headers10[9].height}`);
const tip = headers10[0];
console.log('  info tip height =', tip.height, tip.id);

// wallets
const wA = new Wallet({ type: 'mnemonic', value: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', networkId: 'mainnet' });
const addrA = await wA.getAddress();
const wB = new Wallet({ type: 'mnemonic', value: 'legal winner thank year wave sausage worth useful legal winner thank yellow', networkId: 'mainnet' });
const addrB = await wB.getAddress();
const pubA = pubkeyFromAddress(addrA).toString('hex');
console.log('  info A =', addrA);
console.log('  info B =', addrB);
check('A and B differ', addrA !== addrB);

// P2PK ergoTree straight from sigma-rust (canonical: 00 08 21 <33-byte pubkey>)
const scriptA = E.Contract.pay_to_address(E.Address.from_base58(addrA)).ergo_tree().to_base16_bytes();
console.log('  info scriptA =', scriptA, '(len', scriptA.length / 2, 'bytes)');
const box = {
  boxId: 'a'.repeat(64),
  transactionId: 'b'.repeat(64),
  index: 0,
  value: 10000000000, // 10 ERG
  assets: [],
  creationHeight: tip.height - 100,
  script: scriptA,
  ergoTree: scriptA, // node REST format carries both; sigma-rust reads ergoTree
  extension: [],
  additionalRegisters: {},
};

// sigma-rust validates boxId == hash(content); extract the canonical id it computes.
function canonicalBoxId(b) {
  try {
    E.ErgoBoxes.from_boxes_json([b]);
    return b.boxId;
  } catch (e) {
    const m = String(e && e.message || e).match(/calculated from box serialized bytes ([0-9a-f]{64})/);
    if (!m) throw e;
    return { ...b, boxId: m[1] };
  }
}
const boxOk = canonicalBoxId(box);
const boxesJson = [boxOk];
check('boxId canonicalized', boxOk.boxId !== 'a'.repeat(64), boxOk.boxId);

// --- plain ERG send ---
{
  const txJson = await wA.buildSignedTx({
    boxesJson,
    recipient: addrB,
    amountNano: '500000000', // 0.5 ERG
    tokenId: null,
    height: tip.height,
    headersJson: headers10,
  });
  const tx = JSON.parse(txJson);
  const treeB = E.Contract.pay_to_address(E.Address.from_base58(addrB)).ergo_tree().to_base16_bytes();
  check('signed tx has id', typeof tx.id === 'string' && tx.id.length === 64, tx.id && tx.id.slice(0, 12));
  const proof = tx.inputs && tx.inputs[0] && tx.inputs[0].spendingProof && tx.inputs[0].spendingProof.proofBytes;
  check('signed tx has 1 input with proof', !!proof && String(proof).length >= 40, proof && String(proof).slice(0, 12));
  check('output pays 0.5 ERG to B (ergoTree match)', tx.outputs.some((o) => String(o.value) === '500000000' && o.ergoTree === treeB));
  check('change output back to A (ergoTree match)', tx.outputs.some((o) => o.ergoTree === scriptA && String(o.value) === String(10000000000n - 500000000n - 1100000n)));
  check('fee output present (0.0011 ERG suggested)', tx.outputs.some((o) => String(o.value) === '1100000'));
  check('coin conservation: in == out', String(10000000000n) === tx.outputs.reduce((s, o) => s + BigInt(o.value), 0n).toString());
  // Cryptographically verify the spending proof with sigma-rust's own verifier.
  {
    const signedTx = E.Transaction.from_json(txJson);
    const spendBoxes = E.ErgoBoxes.from_boxes_json(boxesJson);
    const stateCtx = new E.ErgoStateContext(
      E.PreHeader.from_block_header(E.BlockHeader.from_json(JSON.stringify(tip))),
      E.BlockHeaders.from_json(headers10),
      E.Parameters.default_parameters()
    );
    const ok = E.verify_tx_input_proof(0, stateCtx, signedTx, spendBoxes, E.ErgoBoxes.empty());
    check('spending proof VERIFIES (sigma-rust verifier)', ok === true);
  }
  console.log('  info signed tx =', txJson.slice(0, 300) + '…');
}

// --- token send (LIT in box asset): output = dust + tokens, rest to change ---
{
  const LIT = 'c1980d829988229516430a47a5eca376060b6ce859616db0936e78ab25cb6de7';
  const boxTok = canonicalBoxId({ ...boxOk, value: 10000000000, assets: [{ tokenId: LIT, amount: 100000000000 }] });
  const txJson = await wA.buildSignedTx({
    boxesJson: [boxTok],
    recipient: addrB,
    amountNano: '10000000000', // 10 LIT @ 9 decimals
    tokenId: LIT,
    height: tip.height,
    headersJson: headers10,
  });
  const tx = JSON.parse(txJson);
  const proof = tx.inputs && tx.inputs[0] && tx.inputs[0].spendingProof && tx.inputs[0].spendingProof.proofBytes;
  check('token tx signed w/ proof', !!proof && String(proof).length >= 40);
  const outB = tx.outputs.find((o) => (o.assets || []).some((a) => a.tokenId === LIT && String(a.amount) === '10000000000'));
  check('token output has asset (10 LIT)', !!outB);
  check('token output carries min dust ERG value', !!outB && String(outB.value) === '1000000', outB && `value=${outB.value} assets=${JSON.stringify(outB.assets)}`);
  const outChange = tx.outputs.find((o) => o.ergoTree === scriptA);
  const expectChange = 10000000000n - 1000000n - 1100000n; // in - dust - fee
  check('change holds remaining 90 LIT + ERG', !!outChange && String(outChange.value) === expectChange.toString() && (outChange.assets || []).some((a) => a.tokenId === LIT && String(a.amount) === '90000000000'), outChange && `value=${outChange.value} (want ${expectChange}) assets=${JSON.stringify(outChange.assets)}`);
  check('token conservation', String(100000000000n) === tx.outputs.reduce((s, o) => s + BigInt((o.assets || []).find((a) => a.tokenId === LIT)?.amount || 0n), 0n).toString());
  check('ERG conservation (token tx)', String(10000000000n) === tx.outputs.reduce((s, o) => s + BigInt(o.value), 0n).toString());
  // Verify the token tx proof too.
  {
    const signedTx = E.Transaction.from_json(txJson);
    const spendBoxes = E.ErgoBoxes.from_boxes_json([boxTok]);
    const stateCtx = new E.ErgoStateContext(
      E.PreHeader.from_block_header(E.BlockHeader.from_json(JSON.stringify(tip))),
      E.BlockHeaders.from_json(headers10),
      E.Parameters.default_parameters()
    );
    const ok = E.verify_tx_input_proof(0, stateCtx, signedTx, spendBoxes, E.ErgoBoxes.empty());
    check('token tx proof VERIFIES (sigma-rust verifier)', ok === true);
  }
}

console.log(fails === 0 ? '\nFULL SIGNING PATH VERIFIED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
