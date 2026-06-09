import { WASM_B64 } from './lib/wasm-b64';

// ─── LEB128 decoding ────────────────────────────────────────────────

function decodeULEB128(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (true) {
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, offset];
}

function decodeSLEB128(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  while (true) {
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  // Sign-extend if the most significant bit of the last byte was set
  if (shift < 32 && (byte & 0x40)) {
    result |= -(1 << shift);
  }
  return [result, offset];
}

// ─── Offset expression parsing ──────────────────────────────────────

interface OffsetExpr {
  op: string;
  value: number;
}

function parseOffsetExpr(buf: Uint8Array, offset: number): [OffsetExpr, number] {
  const results: OffsetExpr[] = [];
  while (true) {
    const op = buf[offset];
    if (op === 0x41) {
      // i32.const — value is signed LEB128
      const [val, newOff] = decodeSLEB128(buf, offset + 1);
      results.push({ op: 'i32.const', value: val });
      offset = newOff;
    } else if (op === 0x23) {
      // global.get — index is unsigned LEB128
      const [val, newOff] = decodeULEB128(buf, offset + 1);
      results.push({ op: 'global.get', value: val });
      offset = newOff;
    } else if (op === 0x0b) {
      // end
      offset++;
      break;
    } else {
      throw new Error(`Unknown opcode in offset expression: 0x${op.toString(16)} at offset ${offset}`);
    }
  }
  // Return the i32.const value if present, otherwise the first expr
  const constExpr = results.find(r => r.op === 'i32.const');
  return [constExpr || { op: 'unknown', value: 0 }, offset];
}

// ─── Data segment ───────────────────────────────────────────────────

interface DataSegment {
  mode: string;          // "active" (mode 0), "active_mem" (mode 2), "passive" (mode 1)
  memoryIndex?: number;  // only for mode 2
  offset: number;        // resolved target memory offset
  offsetExpr: OffsetExpr[];
  dataBytes: Uint8Array;
}

// ─── WASM binary parsing ────────────────────────────────────────────

function parseWasmDataSection(wasmBytes: Uint8Array): DataSegment[] {
  const textEncoder = new TextDecoder();

  // Check magic: \0asm
  const magic = textEncoder.decode(wasmBytes.slice(0, 4));
  if (magic !== '\0asm') {
    throw new Error(`Invalid WASM magic: ${magic}`);
  }

  // Check version: 1 (little-endian u32 at bytes 4-7)
  const version = wasmBytes[4] | (wasmBytes[5] << 8) | (wasmBytes[6] << 16) | (wasmBytes[7] << 24);
  if (version !== 1) {
    throw new Error(`Unknown WASM version: ${version}`);
  }

  let offset = 8; // skip magic + version

  while (offset < wasmBytes.length) {
    const sectionId = wasmBytes[offset++];
    const [sectionSize, contentStart] = decodeULEB128(wasmBytes, offset);
    offset = contentStart;
    const contentEnd = offset + sectionSize;

    if (sectionId === 11) {
      // ── Data Section ──────────────────────────────────────────
      const [count, dataStart] = decodeULEB128(wasmBytes, offset);
      offset = dataStart;

      const segments: DataSegment[] = [];

      for (let i = 0; i < count; i++) {
        const modeByte = wasmBytes[offset++];

        if (modeByte === 0x00) {
          // Mode 0: active, memory 0, followed by offset expression and data
          const [offsetExpr, afterExpr] = parseOffsetExpr(wasmBytes, offset);
          offset = afterExpr;
          const [dataSize, afterSize] = decodeULEB128(wasmBytes, offset);
          offset = afterSize;
          const dataBytes = wasmBytes.slice(offset, offset + dataSize);
          offset += dataSize;

          const constExpr = offsetExpr;
          segments.push({
            mode: 'active',
            offset: constExpr.value,
            offsetExpr: [offsetExpr],
            dataBytes,
          });
        } else if (modeByte === 0x01) {
          // Mode 1: passive — skip
          const [dataSize, afterSize] = decodeULEB128(wasmBytes, offset);
          offset = afterSize + dataSize; // skip data
          segments.push({
            mode: 'passive',
            offset: -1,
            offsetExpr: [],
            dataBytes: new Uint8Array(0),
          });
        } else if (modeByte === 0x02) {
          // Mode 2: active with explicit memory index
          const [memIndex, afterMem] = decodeULEB128(wasmBytes, offset);
          offset = afterMem;
          const [offsetExpr, afterExpr] = parseOffsetExpr(wasmBytes, offset);
          offset = afterExpr;
          const [dataSize, afterSize] = decodeULEB128(wasmBytes, offset);
          offset = afterSize;
          const dataBytes = wasmBytes.slice(offset, offset + dataSize);
          offset += dataSize;

          const constExpr = offsetExpr;
          segments.push({
            mode: 'active_mem',
            memoryIndex: memIndex,
            offset: constExpr.value,
            offsetExpr: [offsetExpr],
            dataBytes,
          });
        } else {
          throw new Error(`Unknown data segment mode: 0x${modeByte.toString(16)} at offset ${offset - 1}`);
        }
      }

      return segments;
    }

    // Skip other sections
    offset = contentEnd;
  }

  throw new Error('Data section (id=11) not found in WASM binary');
}

// ─── Main ───────────────────────────────────────────────────────────

const wasmBase64 = WASM_B64.replace(/\s/g, '');
const wasmBytes = Uint8Array.from(Buffer.from(wasmBase64, 'base64'));

console.log(`WASM binary size: ${wasmBytes.length} bytes`);
console.log();

const segments = parseWasmDataSection(wasmBytes);

console.log(`Total data segments: ${segments.length}`);
console.log();

// Filter for active segments only (mode 0 or mode 2)
const activeSegments = segments.filter(s => s.mode === 'active' || s.mode === 'active_mem');

console.log(`Active data segments: ${activeSegments.length}`);
console.log();

for (let i = 0; i < segments.length; i++) {
  const seg = segments[i];
  if (seg.mode === 'passive') {
    console.log(`Segment ${i}: PASSIVE (skipped)`);
  } else {
    console.log(`Segment ${i}: ${seg.mode}${seg.memoryIndex !== undefined ? ` (mem=${seg.memoryIndex})` : ''} → offset = ${seg.offset}, data size = ${seg.dataBytes.length}`);
  }
}

console.log();
console.log('═'.repeat(70));
console.log('TypeScript-ready arrays for active data segments:');
console.log('═'.repeat(70));
console.log();

// Output as arrays that can be copy-pasted into TypeScript
for (let i = 0; i < activeSegments.length; i++) {
  const seg = activeSegments[i];
  const hexStr = Array.from(seg.dataBytes)
    .map(b => '0x' + b.toString(16).padStart(2, '0'))
    .join(', ');

  console.log(`// Active segment at offset=${seg.offset}, size=${seg.dataBytes.length} bytes`);
  console.log(`const DATA_SEG_${i}_OFFSET = ${seg.offset};`);
  console.log(`const DATA_SEG_${i}_BYTES: number[] = [${hexStr}];`);
  console.log();
}