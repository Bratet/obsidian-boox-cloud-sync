// Read-only decoder for Fleece, the binary JSON format Couchbase Lite stores
// document bodies in. Covers what BOOX note databases contain: scalars,
// strings, binary, arrays, dicts and shared (integer) dict keys.
// Format: https://github.com/couchbaselabs/fleece/blob/master/Fleece.md
const utf8 = new TextDecoder();

export class FleeceError extends Error {}

export function decodeFleece(data: Uint8Array, sharedKeys: string[] = []): unknown {
  if (data.length < 2) throw new FleeceError("Fleece data is too short.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const varint = (pos: number): [number, number] => {
    let value = 0, shift = 0;
    for (;;) {
      if (pos >= data.length || shift > 35) throw new FleeceError("Invalid Fleece varint.");
      const byte = data[pos++];
      value += (byte & 0x7f) * 2 ** shift; shift += 7;
      if (byte < 0x80) return [value, pos];
    }
  };
  // Resolve a slot that may hold a pointer (high bit set) to the value it targets.
  const target = (pos: number, wide: boolean): number => {
    if (!(data[pos] & 0x80)) return pos;
    const offset = wide ? (view.getUint32(pos) & 0x3fffffff) * 2 : (view.getUint16(pos) & 0x7fff) * 2;
    if (wide && view.getUint32(pos) & 0x40000000) throw new FleeceError("External Fleece pointers are not supported.");
    if (offset === 0 || offset > pos) throw new FleeceError("Invalid Fleece pointer.");
    const next = pos - offset;
    // A pointer reached through a pointer is always wide.
    return data[next] & 0x80 ? target(next, true) : next;
  };
  const value = (pos: number, depth: number): unknown => {
    if (depth > 64) throw new FleeceError("Fleece data is nested too deeply.");
    if (pos < 0 || pos >= data.length) throw new FleeceError("Fleece value out of range.");
    const tag = data[pos] >> 4, low = data[pos] & 0x0f;
    switch (tag) {
      case 0: { const v = (low << 8) | data[pos + 1]; return v & 0x800 ? v - 0x1000 : v; }
      case 1: {
        const size = (low & 7) + 1; let v = 0n;
        for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[pos + 1 + i]);
        if (!(low & 8) && v & (1n << BigInt(size * 8 - 1))) v -= 1n << BigInt(size * 8);
        return Number(v);
      }
      case 2: return low & 8 ? view.getFloat64(pos + 2, true) : view.getFloat32(pos + 2, true);
      case 3: return low & 0x8 ? (low & 0x4 ? undefined : true) : low & 0x4 ? false : null;
      case 4: case 5: {
        let size = low, start = pos + 1;
        if (size === 0x0f) [size, start] = varint(start);
        if (start + size > data.length) throw new FleeceError("Fleece string out of range.");
        const bytes = data.subarray(start, start + size);
        return tag === 4 ? utf8.decode(bytes) : bytes.slice();
      }
      case 6: case 7: {
        const wide = !!(low & 8), width = wide ? 4 : 2;
        let count = ((low & 7) << 8) | data[pos + 1], start = pos + 2;
        if (count === 0x7ff) { [count, start] = varint(start); start += start & 1; }
        const slot = (i: number) => value(target(start + i * width, wide), depth + 1);
        if (tag === 6) return Array.from({ length: count }, (_, i) => slot(i));
        const out: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const key = slot(2 * i);
          const name = typeof key === "number" ? sharedKeys[key] : key;
          if (typeof name !== "string") throw new FleeceError("Unknown Fleece shared key.");
          out[name] = slot(2 * i + 1);
        }
        return out;
      }
      default: return value(target(pos, false), depth + 1);
    }
  };
  return value(target(data.length - 2, false), 0);
}
