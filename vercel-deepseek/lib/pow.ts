/**
 * PoW 求解器 - 使用 Node.js WebAssembly API
 *
 * 关键发现: WASM 没有 import section, memory 是内部定义的(section 5)。
 * WebAssembly.Instance 创建时无需传入 imports,模块会自己创建 memory。
 * 必须使用 instance.exports.memory 而不是自己创建的 memory。
 *
 * Node.js 的 WebAssembly 运行时不会自动加载 active data segment,
 * 因此需要手动从 WASM 二进制中提取数据段并写入 memory。
 */
import { WASM_B64 } from "./wasm-b64";

let wasmInstance: WebAssembly.Instance | null = null;
let wasmExports: Record<string, Function> = {};

// 使用 exports 中的 memory (模块自己的 memory)
function getMemory(): WebAssembly.Memory {
  if (!wasmInstance) throw new Error("WASM not initialized");
  return wasmInstance.exports["memory"] as WebAssembly.Memory;
}

function getMemoryView(): Uint8Array {
  return new Uint8Array(getMemory().buffer);
}

/**
 * 从 WASM 二进制中解析 active data segment 并写入模块自己的 memory。
 */
function initDataSegments(wasmBytes: Buffer): void {
  const memView = getMemoryView();

  // 跳过 magic(4) + version(4) = 8 字节
  let pos = 8;
  while (pos < wasmBytes.length) {
    const sectionId = wasmBytes[pos++];
    // 读取 section size (LEB128 unsigned)
    let size = 0;
    let shift = 0;
    while (true) {
      const b = wasmBytes[pos++];
      size |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const sectionStart = pos;

    if (sectionId === 11) {
      // Data section
      // 读取段数量
      let count = 0;
      let cShift = 0;
      while (true) {
        const b = wasmBytes[pos++];
        count |= (b & 0x7f) << cShift;
        if ((b & 0x80) === 0) break;
        cShift += 7;
      }

      for (let i = 0; i < count; i++) {
        const mode = wasmBytes[pos++];

        if (mode === 1) {
          // Passive segment - 跳过
          let dataSize = 0;
          let ds = 0;
          while (true) {
            const b = wasmBytes[pos++];
            dataSize |= (b & 0x7f) << ds;
            if ((b & 0x80) === 0) break;
            ds += 7;
          }
          pos += dataSize;
          continue;
        }

        if (mode === 2) {
          // 显式 memory index - 跳过
          let mi = 0;
          let ms = 0;
          while (true) {
            const b = wasmBytes[pos++];
            mi |= (b & 0x7f) << ms;
            if ((b & 0x80) === 0) break;
            ms += 7;
          }
        }

        // 读取 offset expression - 期望是 (i32.const N) (end)
        // opcode 0x41 = i32.const, 0x0b = end
        let offset = 0;
        while (true) {
          const op = wasmBytes[pos++];
          if (op === 0x41) {
            // i32.const - 读取 LEB128 有符号值
            let val = 0;
            let s = 0;
            while (true) {
              const b = wasmBytes[pos++];
              val |= (b & 0x7f) << s;
              if ((b & 0x80) === 0) {
                // 符号扩展
                if ((b & 0x40) !== 0) {
                  val |= -1 << (s + 7);
                }
                break;
              }
              s += 7;
            }
            offset = val;
          } else if (op === 0x0b) {
            break;
          }
        }

        // 读取数据大小
        let dataSize = 0;
        let ds = 0;
        while (true) {
          const b = wasmBytes[pos++];
          dataSize |= (b & 0x7f) << ds;
          if ((b & 0x80) === 0) break;
          ds += 7;
        }

        // 手动复制数据到 memory
        for (let j = 0; j < dataSize; j++) {
          memView[offset + j] = wasmBytes[pos + j];
        }
        pos += dataSize;
      }
    }

    pos = sectionStart + size;
  }
}

function getWasmInstance() {
  if (wasmInstance) return;

  const wasmBytes = Buffer.from(WASM_B64, "base64");
  const wasmModule = new WebAssembly.Module(wasmBytes);

  // 模块没有 imports (无 import section), 直接实例化
  // 模块内部定义了 memory (section 5), 会自动创建
  wasmInstance = new WebAssembly.Instance(wasmModule, {});

  // *** 手动初始化数据段到模块自己的 memory ***
  initDataSegments(wasmBytes);

  wasmExports = Object.fromEntries(
    Object.entries(wasmInstance.exports).map(([k, v]) => [k, v])
  ) as Record<string, Function>;
}

function writeStringToWasm(s: string): [number, number] {
  if (typeof s !== "string") {
    throw new Error(
      `writeStringToWasm: expected string, got ${typeof s}: ${JSON.stringify(s)}`
    );
  }
  const buf = Buffer.from(s, "utf-8");
  const len = buf.length;
  const realloc = wasmExports["__wbindgen_export_0"] as (len: number, align: number) => number;

  // realloc may grow memory, so get a fresh view AFTER the call
  const ptr = realloc(len, 1);
  const mem = new Uint8Array(getMemory().buffer);
  mem.set(buf, ptr);

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

  const addToSp = wasmExports["__wbindgen_add_to_stack_pointer"] as (n: number) => number;
  const sp = addToSp(-16);

  const wasmSolve = wasmExports["wasm_solve"] as (
    sp: number,
    cP: number, cL: number,
    pP: number, pL: number,
    diff: number
  ) => void;
  wasmSolve(sp, cPtr, cLen, pPtr, pLen, difficulty);

  // Always get fresh view after WASM call
  const raw = new Uint8Array(getMemory().buffer).slice(sp, sp + 16);
  addToSp(16);

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const status = view.getInt32(0, true);
  const answer = view.getFloat64(8, true);

  if (status !== 1) {
    throw new Error(
      `PoW solve failed: status=${status}, answer=${answer}`
    );
  }

  return Math.floor(answer);
}