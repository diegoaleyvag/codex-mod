// Hooks run without Node's crypto module. Hash UTF-8 incrementally so even a
// large recovery payload needs only one compression block of scratch space.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotate = (v: number, n: number) => (v >>> n) | (v << (32 - n))
export type Fingerprint = { length: number; sha256: string }

export function fingerprint(text: string): Fingerprint {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Array<number>(64).fill(0)
  let used = 0
  let bytes = 0
  const put = (byte: number) => {
    words[used >>> 2] |= byte << (24 - (used % 4) * 8)
    if (++used !== 64) return
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!, y = words[i - 2]!
      words[i] = (words[i - 16]! + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7]! + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) | 0
    }
    let [a, b, c, d, e, f, g, v] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t = (v + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + words[i]!) | 0
      const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      v = g
      g = f
      f = e
      e = (d + t) | 0
      d = c
      c = b
      b = a
      a = (t + u) | 0
    }
    for (const [i, n] of [a, b, c, d, e, f, g, v].entries()) h[i] = (h[i]! + n) | 0
    words.fill(0)
    used = 0
  }
  for (const char of text) {
    let c = char.codePointAt(0)!
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) {
      put(c)
      bytes++
    } else if (c < 0x800) {
      put(0xc0 | (c >>> 6))
      put(0x80 | (c & 63))
      bytes += 2
    } else if (c < 0x10000) {
      put(0xe0 | (c >>> 12))
      put(0x80 | ((c >>> 6) & 63))
      put(0x80 | (c & 63))
      bytes += 3
    } else {
      put(0xf0 | (c >>> 18))
      put(0x80 | ((c >>> 12) & 63))
      put(0x80 | ((c >>> 6) & 63))
      put(0x80 | (c & 63))
      bytes += 4
    }
  }
  put(0x80)
  while (used !== 56) put(0)
  const high = Math.floor(bytes / 0x20000000), low = (bytes * 8) >>> 0
  for (const n of [high, low]) for (const shift of [24, 16, 8, 0]) put((n >>> shift) & 255)
  return { length: text.length, sha256: h.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('') }
}

export function matchesIdentity(record: Record<string, any>, field: string, text: string): boolean {
  if (typeof record[field] === 'string') return record[field] === text
  const saved = record[`${field}Fingerprint`]
  return saved?.length === text.length && saved.sha256 === fingerprint(text).sha256
}
