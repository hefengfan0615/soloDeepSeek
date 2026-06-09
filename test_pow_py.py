import base64, wasmtime, ctypes, struct
import sys
sys.path.insert(0, '/workspace')
from deepseek import WASM_B64

wasm_bytes = base64.b64decode(WASM_B64)
engine = wasmtime.Engine()
store = wasmtime.Store(engine)
module = wasmtime.Module(engine, wasm_bytes)
instance = wasmtime.Instance(store, module, [])

exps = instance.exports(store)
memory = exps["memory"]

# write string helper
def write_str(bs: bytes):
    realloc_fn = exps["__wbindgen_export_0"]
    ptr = realloc_fn(store, len(bs), 1)
    data_ptr = ctypes.cast(memory.data_ptr(store), ctypes.c_void_p).value
    buf = (ctypes.c_uint8 * len(bs)).from_address(data_ptr + ptr)
    for i, b in enumerate(bs):
        buf[i] = b
    return ptr, len(bs)

# Call hash and get result
s = b"hello"
ptr, ptr_len = write_str(s)

add_sp = exps["__wbindgen_add_to_stack_pointer"]
sp = add_sp(store, -16)

hash_fn = exps["wasm_deepseek_hash_v1"]

# Read memory BEFORE call
addr = ctypes.cast(memory.data_ptr(store), ctypes.c_void_p).value
before = bytes((ctypes.c_uint8 * 16).from_address(addr + sp))
print("Before hash at sp:", before.hex())

# Call hash
hash_fn(store, sp, ptr, ptr_len)

# Read memory AFTER call
after = bytes((ctypes.c_uint8 * 16).from_address(addr + sp))
print("After hash at sp:", after.hex())

# Parse result
result = struct.unpack("<Q", after[:8])[0]
print("Hash result:", result)

add_sp(store, 16)

# Now test wasm_solve with the PoW challenge
print("\n--- wasm_solve ---")
challenge = b"4a2e73d6eab49515446e744a72538e810cac580cbbfbbbd31da29d136b6f247d"
salt = b"b5de5ee52e00d9b2ce18"
expire_at = 1780965235411
difficulty = 144000

prefix = f"{salt.decode()}_{expire_at}_".encode()

c_ptr, c_len = write_str(challenge)
p_ptr, p_len = write_str(prefix)

sp2 = add_sp(store, -16)

solve_fn = exps["wasm_solve"]
solve_fn(store, sp2, c_ptr, c_len, p_ptr, p_len, float(difficulty))

raw = bytes((ctypes.c_uint8 * 16).from_address(data_ptr + sp2))
print("Solve result raw:", raw.hex())
status = struct.unpack("<i", raw[:4])[0]
answer = struct.unpack("<d", raw[8:16])[0]
print("Status:", status, "Answer:", answer, "Floor:", int(answer))

add_sp(store, 16)