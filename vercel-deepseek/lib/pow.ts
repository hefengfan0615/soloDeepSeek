import { WASM_B64 } from "./wasm-b64";

let wasmInstance: WebAssembly.Instance | null = null;
let memory: WebAssembly.Memory;
let wasmExports: WebAssembly.Exports;

function getWasmInstance(): WebAssembly.Instance {
  if (wasmInstance) return wasmInstance;

  const wasmBytes = Buffer.from(WASM_B64, "base64");
  const module = new WebAssembly.Module(wasmBytes);
  memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
  wasmInstance = new WebAssembly.Instance(module, {
    env: { memory },
  });
  wasmExports = wasmInstance.exports;

  return wasmInstance;
}

function writeStringToWasm(s: string): [number, number] {
  const buf = Buffer.from(s, "utf-8");
  const len = buf.length;
  const ptr = (wasmExports["__wbindgen_export_0"] as Function)(len, 1);
  const view = new Uint8Array(memory.buffer, ptr, len);
  view.set(buf);
  return [ptr, len];
}

export function solvePow(
  challenge: string,
  salt: string,
  expireAt: number,
  difficulty: number
): number {
  getWasmInstance();

  const prefix = `${salt}_${expireAt}_`;
  const [cPtr, cLen] = writeStringToWasm(challenge);
  const [pPtr, pLen] = writeStringToWasm(prefix);

  const sp = (wasmExports["__wbindgen_add_to_stack_pointer"] as Function)(-16);
  (wasmExports["wasm_solve"] as Function)(sp, cPtr, cLen, pPtr, pLen, difficulty);
  (wasmExports["__wbindgen_add_to_stack_pointer"] as Function)(16);

  const raw = new Uint8Array(memory.buffer, sp, 16);
  const status = new Int32Array(raw.buffer, raw.byteOffset, 1)[0];
  const answer = new Float64Array(raw.buffer, raw.byteOffset + 8, 1)[0];

  if (status !== 1) {
    throw new Error(`PoW solve failed: status=${status}, answer=${answer}`);
  }

  return Math.floor(answer);
}