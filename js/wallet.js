/* EUTXO.DEX — wallet module.
 *
 * Real Ergo keys via sigma-rust (ergo-lib-wasm), loaded dynamically:
 *   1) local vendor copy  ./vendor/ergo-lib/ergo_lib_wasm_bg.{js,wasm}
 *   2) CDN fallback       https://unpkg.com/ergo-lib-wasm-browser@0.28.0/ergo_lib_wasm_bg.{js,wasm}
 * Loaded via fetch + WebAssembly.instantiate (works in every browser;
 * wasm-ESM imports are rejected by many browser builds).
 *
 * Key formats (both work):
 *   - mnemonic:  12/24 BIP39 words -> sigma-rust master-key derivation:
 *                 HMAC-SHA512("Bitcoin seed", to_seed(phrase, pass))[0..32]  (same as Ergo wallets)
 *   - seed:      64-hex-char raw dlog secret (32 random bytes, CSPRNG)
 *
 * Signing path (verified against ergo_lib_wasm.d.ts):
 *   SecretKey.dlog_from_bytes(seed) -> get_address()
 *   Wallet.from_mnemonic(...).sign_transaction(stateCtx, unsignedTx, boxes, dataBoxes)
 */

/* Engine loading — universal across every browser (no wasm-ESM import needed,
 * which many browsers reject for module scripts). Fetches the .wasm bytes,
 * instantiates with WebAssembly.instantiate, and wires the glue module's own
 * exported functions as the import object (the wasm imports them by name).
 * Candidates: local vendor copy first, then CDN fallback. */
const CDN_BASE = 'https://unpkg.com/ergo-lib-wasm-browser@0.28.0/';
const CANDIDATES = [
  { glue: '../vendor/ergo-lib/ergo_lib_wasm_bg.js', wasm: '../vendor/ergo-lib/ergo_lib_wasm_bg.wasm' },
  { glue: CDN_BASE + 'ergo_lib_wasm_bg.js', wasm: CDN_BASE + 'ergo_lib_wasm_bg.wasm' },
];

let ergoLibPromise = null;

async function wasmBytesFor(relOrAbs) {
  const absUrl = new URL(relOrAbs, import.meta.url);
  if (absUrl.protocol === 'http:' || absUrl.protocol === 'https:') {
    const res = await fetch(absUrl.href);
    if (!res.ok) throw new Error('wasm fetch failed: HTTP ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  // file: URL (Node test context) — read straight from disk
  const { fileURLToPath } = await import('node:url');
  const { readFileSync } = await import('node:fs');
  return new Uint8Array(readFileSync(fileURLToPath(absUrl)));
}

async function instantiateCandidate(c) {
  const glue = await import(/* @vite-ignore */ c.glue);
  if (typeof glue.__wbg_set_wasm !== 'function') throw new Error('glue module missing __wbg_set_wasm');
  const bytes = await wasmBytesFor(c.wasm);
  const mod = new WebAssembly.Module(bytes);
  const importObject = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (typeof glue[imp.name] !== 'function') throw new Error('glue missing imported fn: ' + imp.name);
    importObject[imp.module] ??= {};
    importObject[imp.module][imp.name] = glue[imp.name];
  }
  const instance = await WebAssembly.instantiate(mod, importObject);
  glue.__wbg_set_wasm(instance.exports);
  if (!glue.Wallet || !glue.Mnemonic) throw new Error('module missing exports');
  return glue;
}

export function loadErgoLib() {
  if (ergoLibPromise) return ergoLibPromise;
  ergoLibPromise = (async () => {
    let lastErr = null;
    for (const c of CANDIDATES) {
      try {
        return await instantiateCandidate(c);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`ergo-lib (sigma-rust) unavailable: ${lastErr ? lastErr.message : 'unknown'}`);
  })();
  ergoLibPromise.catch(() => { ergoLibPromise = null; });
  return ergoLibPromise;
}

/** HMAC-SHA512 via WebCrypto (secure contexts: localhost / https). Returns 64 bytes. */
async function hmacSha512(keyBytes, dataBytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('WebCrypto is unavailable. Open EUTXO.DEX through http://localhost (double-click serve.bat) and reload.');
  }
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, dataBytes));
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Bad hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/** New wallet secret: 32 random bytes (dlog scalar) as hex. */
export function createSeedHex() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export class Wallet {
  /**
   * @param {{type:'mnemonic'|'seed', value:string, networkId:string}} record
   */
  constructor(record) {
    this.type = record.type;
    this.value = record.value;
    this.networkId = record.networkId || 'mainnet';
  }

  _prefix() {
    return this.networkId === 'testnet' ? 16 /* NetworkPrefix.Testnet */ : 0 /* NetworkPrefix.Mainnet */;
  }

  async _secret(E) {
    if (this.type === 'mnemonic') {
      const phrase = this.value.trim().replace(/\s+/g, ' ');
      const seed = E.Mnemonic.to_seed(phrase, '');
      // sigma-rust Wallet::from_mnemonic == ExtSecretKey::derive_master(seed):
      // I = HMAC-SHA512(key="Bitcoin seed", data=seed64); secret key = I[0..32] (BIP32 master)
      const I = await hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed);
      return E.SecretKey.dlog_from_bytes(I.subarray(0, 32));
    }
    if (this.type === 'seed') {
      return E.SecretKey.dlog_from_bytes(hexToBytes(this.value));
    }
    throw new Error('Unknown wallet key type');
  }

  /** Derive the P2PK address (account 0) for this key. */
  async getAddress() {
    const E = await loadErgoLib();
    return (await this._secret(E)).get_address().to_base58(this._prefix());
  }

  async _wallet(E) {
    if (this.type === 'mnemonic') {
      return E.Wallet.from_mnemonic(this.value.trim().replace(/\s+/g, ' '), '');
    }
    const secret = await this._secret(E);
    const secrets = new E.SecretKeys();
    secrets.add(secret);
    return E.Wallet.from_secrets(secrets);
  }

  /**
   * Build + sign a send transaction (P2PK output, optionally with a token).
   * @param {object} args
   * @param {Array}  args.boxesJson     unspent boxes JSON (from node /addresses/{a}/unspent)
   * @param {string} args.recipient     base58 recipient address
   * @param {string} args.amountNano    amount as decimal string of nano units
   *                                     (nano-ERGs for plain ERG; token nano-units for a token)
   * @param {string} [args.tokenId]     token id (omit / 'ERG' for plain ERG)
   * @param {number} args.height        chain height
   * @param {Array}  args.headersJson   last 10 block header JSON objects, newest first (tip at index 0)
   * @returns {Promise<string>} signed tx JSON (ready for POST /transactions)
   */
  async buildSignedTx(args) {
    const E = await loadErgoLib();
    const { boxesJson, recipient, amountNano, tokenId } = args;
    const height = Math.floor(args.height || 0);
    if (height <= 0) throw new Error('Unknown chain height');

    const destAddr = E.Address.from_base58(recipient);
    const changeAddr = E.Address.from_base58(await this.getAddress());

    const inputs = E.ErgoBoxes.from_boxes_json(boxesJson);

    const isToken = !!(tokenId && tokenId !== 'ERG');
    // Output box value: a token send carries minimum dust (the tokens are the
    // payload); a plain ERG send moves the full amount.
    const dustNano = E.BoxValue.SAFE_USER_MIN().as_i64().to_str(); // 1,000,000
    const outValueNano = isToken ? dustNano : amountNano;

    // Miner fee box is appended by TxBuilder ON TOP of change (change = selected - target),
    // so the selector target must cover outValue + fee or inputs end up short by the fee.
    const fee = E.TxBuilder.SUGGESTED_TX_FEE(); // 1,100,000 nanoERGs
    const target = E.BoxValue.from_i64(E.I64.from_str(outValueNano).checked_add(fee.as_i64()));

    // Target tokens let the selector verify selected boxes actually contain the tokens
    // and prefer boxes holding them.
    const targetTokens = new E.Tokens();
    if (isToken) {
      targetTokens.add(
        new E.Token(E.TokenId.from_str(tokenId), E.TokenAmount.from_i64(E.I64.from_str(amountNano)))
      );
    }

    const selector = new E.SimpleBoxSelector();
    const selection = selector.select(inputs, target, targetTokens);

    const builder = new E.ErgoBoxCandidateBuilder(
      E.BoxValue.from_i64(E.I64.from_str(outValueNano)),
      E.Contract.pay_to_address(destAddr),
      height
    );
    if (isToken) {
      builder.add_token(E.TokenId.from_str(tokenId), E.TokenAmount.from_i64(E.I64.from_str(amountNano)));
    }
    const out = builder.build();

    const candidates = new E.ErgoBoxCandidates(out);
    const txBuilder = E.TxBuilder.new(selection, candidates, height, fee, changeAddr);
    const unsigned = txBuilder.build();

    // sigma-rust's ErgoStateContext requires the last 10 headers, newest first
    // (headers[0] must be the tip — it becomes the PreHeader).
    const headersArr = Array.isArray(args.headersJson) ? args.headersJson : [];
    if (headersArr.length < 10) {
      throw new Error('Need the last 10 block headers (newest first) for the state context');
    }
    const tip = headersArr[0];
    const preHeader = E.PreHeader.from_block_header(E.BlockHeader.from_json(JSON.stringify(tip)));
    const headers = E.BlockHeaders.from_json(headersArr.slice(0, 10));
    const params = E.Parameters.default_parameters();
    const stateCtx = new E.ErgoStateContext(preHeader, headers, params);

    const wallet = await this._wallet(E);
    const signed = wallet.sign_transaction(stateCtx, unsigned, selection.boxes(), E.ErgoBoxes.empty());
    if (signed && typeof signed.to_json === 'function') return signed.to_json();
    return JSON.stringify(signed);
  }

  /** Sign an arbitrary message with the P2PK key -> hex signature. */
  async signMessage(message) {
    const E = await loadErgoLib();
    const secret = await this._secret(E);
    const addr = secret.get_address();
    const wallet = await this._wallet(E);
    const bytes = new TextEncoder().encode(message);
    return bytesToHex(wallet.sign_message_using_p2pk(addr, bytes));
  }
}

/** Validate a mnemonic phrase: 12/24 words and derivable to a valid Ergo address. */
export async function validateMnemonic(phrase, networkId) {
  const words = String(phrase).trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) throw new Error('Mnemonic must be 12 or 24 words');
  const w = new Wallet({ type: 'mnemonic', value: phrase, networkId });
  const addr = await w.getAddress();
  if (!addr || addr.length < 40) throw new Error('Could not derive a valid Ergo address');
  return addr;
}

/** Validate a 64-hex seed. */
export async function validateSeed(seedHex, networkId) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(seedHex).trim())) throw new Error('Seed must be 64 hex characters (32 bytes)');
  const w = new Wallet({ type: 'seed', value: seedHex.trim().toLowerCase(), networkId });
  return w.getAddress();
}

/** Detect the Ergo browser extension (window.ergo), best-effort / read-only. */
export async function detectExtension() {
  const ext = (typeof window !== 'undefined' && window.ergo) || null;
  if (!ext || typeof ext.request !== 'function') return null;
  for (const method of ['ergo_accounts', 'eth_accounts']) {
    try {
      const accounts = await ext.request({ method });
      if (accounts && accounts.length) return { accounts };
    } catch { /* try next */ }
  }
  return ext ? { accounts: [] } : null;
}
