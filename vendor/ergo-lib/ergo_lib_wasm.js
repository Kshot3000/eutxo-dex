import * as wasm from "./ergo_lib_wasm_bg.wasm";
import { __wbg_set_wasm } from "./ergo_lib_wasm_bg.js";
__wbg_set_wasm(wasm);
export * from "./ergo_lib_wasm_bg.js";
