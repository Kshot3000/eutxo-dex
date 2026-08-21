/* EUTXO.DEX universal loader (all browsers + Node).
 * Replaces the wasm-ESM import (`import * as wasm from "./...wasm"`), which
 * many browsers reject for module scripts. Fetches the module bytes, then
 * instantiates with the glue module's own exported functions as imports. */
import * as glue from "./ergo_lib_wasm_bg.js";

const absUrl = new URL('./ergo_lib_wasm_bg.wasm', import.meta.url);
let bytes;
if (absUrl.protocol === 'http:' || absUrl.protocol === 'https:') {
  const res = await fetch(absUrl.href);
  if (!res.ok) throw new Error('ergo-lib wasm fetch failed: HTTP ' + res.status);
  bytes = new Uint8Array(await res.arrayBuffer());
} else {
  const { fileURLToPath } = await import('node:url');
  const { readFileSync } = await import('node:fs');
  bytes = new Uint8Array(readFileSync(fileURLToPath(absUrl)));
}

const mod = new WebAssembly.Module(bytes);
const importObject = {};
for (const imp of WebAssembly.Module.imports(mod)) {
  if (typeof glue[imp.name] !== 'function') throw new Error('glue missing imported fn: ' + imp.name);
  importObject[imp.module] ??= {};
  importObject[imp.module][imp.name] = glue[imp.name];
}
const instance = await WebAssembly.instantiate(mod, importObject);
glue.__wbg_set_wasm(instance.exports);

export * from "./ergo_lib_wasm_bg.js";
