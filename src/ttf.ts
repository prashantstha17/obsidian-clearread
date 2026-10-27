export interface TTPoint { x: number; y: number; on: boolean }
export interface TTGlyph { contours: TTPoint[][]; advance: number; lsb: number; xMin: number }
export interface TTFont {
  unitsPerEm: number; ascender: number; descender: number;
  numGlyphs: number; cmap: Map<number, number>; glyphs: TTGlyph[];
}

class R {
  dv: DataView;
  constructor(public data: Uint8Array) {
    this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8(o: number) { return this.dv.getUint8(o); }
  i8(o: number) { return this.dv.getInt8(o); }
  u16(o: number) { return this.dv.getUint16(o); }
  i16(o: number) { return this.dv.getInt16(o); }
  u32(o: number) { return this.dv.getUint32(o); }
}

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); }
  i16(v: number) { this.b.push((v >> 8) & 255, v & 255); }
  u16(v: number) { this.i16(v); }
  u32(v: number) { this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  raw(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.b.push(a[i]); }
  pad4() { while (this.b.length % 4) this.b.push(0); }
  bytes() { return new Uint8Array(this.b); }
}

function tablesOf(r: R): Map<string, [number, number]> {
  const n = r.u16(4);
  const m = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(r.u8(o), r.u8(o + 1), r.u8(o + 2), r.u8(o + 3));
    m.set(tag, [r.u32(o + 8), r.u32(o + 12)]);
  }
  return m;
}

export function parseTTF(data: Uint8Array, withGlyphs: boolean): TTFont {
  const r = new R(data);
  const sfnt = r.u32(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) {
    throw new Error("Not a TrueType font (.otf/.woff CFF unsupported in v1)");
  }
  const t = tablesOf(r);
  if (withGlyphs && !t.has("glyf")) {
    throw new Error("Font has no glyf table (CFF-based) - unsupported in v1");
  }
  const head = t.get("head")!;
  const maxp = t.get("maxp")!;
  const hhea = t.get("hhea")!;
  const hmtx = t.get("hmtx")!;
  const unitsPerEm = r.u16(head[0] + 18);
  const locaFmt = r.i16(head[0] + 50);
  const numGlyphs = r.u16(maxp[0] + 4);
  const ascender = r.i16(hhea[0] + 4);
  const descender = r.i16(hhea[0] + 6);
  const nHMetrics = r.u16(hhea[0] + 34);

  const advances: number[] = [];
  const lsbs: number[] = [];
  for (let i = 0; i < nHMetrics; i++) {
    advances.push(r.u16(hmtx[0] + i * 4));
    lsbs.push(r.i16(hmtx[0] + i * 4 + 2));
  }
  for (let i = nHMetrics; i < numGlyphs; i++) {
    advances.push(advances[nHMetrics - 1] || 0);
    lsbs.push(r.i16(hmtx[0] + (nHMetrics - 1) * 4 + 2 + (i - nHMetrics + 1) * 2));
  }

  const cmap = new Map<number, number>();
  const cmapT = t.get("cmap");
  if (cmapT) {
    const base = cmapT[0];
    const nSub = r.u16(base + 2);
    for (let i = 0; i < nSub; i++) {
      const off = base + r.u32(base + 8 + i * 8);
      const fmt = r.u16(off);
      if (fmt === 4) {
        const segCount = r.u16(off + 6) / 2;
        const endO = off + 14;
        const startO = endO + 2 * segCount + 2;
        const deltaO = startO + 2 * segCount;
        const roO = deltaO + 2 * segCount;
        for (let s = 0; s < segCount; s++) {
          const end = r.u16(endO + s * 2);
          const start = r.u16(startO + s * 2);
          const delta = r.i16(deltaO + s * 2);
          const ro = r.u16(roO + s * 2);
          for (let c = start; c <= end; c++) {
            let g: number;
            if (ro === 0) g = (c + delta) & 0xffff;
            else {
              g = r.u16(roO + s * 2 + ro + (c - start) * 2);
              if (g) g = (g + delta) & 0xffff;
            }
            if (g) cmap.set(c, g);
          }
        }
      } else if (fmt === 12) {
        const nGroups = r.u32(off + 12);
        for (let gI = 0; gI < nGroups; gI++) {
          const sC = r.u32(off + 16 + gI * 12);
          const eC = r.u32(off + 20 + gI * 12);
          const sG = r.u32(off + 24 + gI * 12);
          for (let c = sC; c <= eC; c++) cmap.set(c, sG + (c - sC));
        }
      }
    }
  }

  const glyphs: TTGlyph[] = [];
  if (withGlyphs) {
    const locaT = t.get("loca")!;
    const glyfT = t.get("glyf")!;
    const glyfBase = glyfT[0];
    const offsets: number[] = [];
    for (let i = 0; i <= numGlyphs; i++) {
      offsets.push(locaFmt === 1 ? r.u32(locaT[0] + i * 4) : r.u16(locaT[0] + i * 2) * 2);
    }

    const contoursOf = (gid: number, depth: number): TTPoint[][] => {
      if (depth > 6 || gid < 0 || gid >= numGlyphs) return [];
      const start = offsets[gid];
      const end = offsets[gid + 1];
      if (start === end) return [];
      const off = glyfBase + start;
      const n = r.i16(off);
      if (n >= 0) {
        const g = parseSimpleGlyph(r, off);
        return g ? g.contours : [];
      }
      let p = off + 10;
      const out: TTPoint[][] = [];
      for (;;) {
        const flags = r.u16(p); p += 2;
        const subGid = r.u16(p); p += 2;
        let arg1 = 0, arg2 = 0;
        if (flags & 1) { arg1 = r.i16(p); p += 2; arg2 = r.i16(p); p += 2; }
        else { arg1 = r.i8(p); p += 1; arg2 = r.i8(p); p += 1; }
        let a = 1, b = 0, c = 0, d = 1;
        if (flags & 8) { const s = r.i16(p) / 16384; p += 2; a = s; d = s; }
        else if (flags & 0x40) { a = r.i16(p) / 16384; p += 2; d = r.i16(p) / 16384; p += 2; }
        else if (flags & 0x80) {
          a = r.i16(p) / 16384; p += 2; b = r.i16(p) / 16384; p += 2;
          c = r.i16(p) / 16384; p += 2; d = r.i16(p) / 16384; p += 2;
        }
        let dx = 0, dy = 0;
        if (flags & 2) { dx = arg1; dy = arg2; }
        for (const cont of contoursOf(subGid, depth + 1)) {
          out.push(cont.map((pt) => ({
            x: Math.round(a * pt.x + c * pt.y + dx),
            y: Math.round(b * pt.x + d * pt.y + dy),
            on: pt.on
          })));
        }
        if (!(flags & 0x20)) break;
      }
      return out;
    };

    for (let gid = 0; gid < numGlyphs; gid++) {
      const contours = contoursOf(gid, 0);
      let xMin = 0;
      if (contours.length) {
        xMin = Infinity;
        contours.forEach((ct) => ct.forEach((pt) => { xMin = Math.min(xMin, pt.x); }));
      }
      glyphs.push({
        contours,
        advance: advances[gid] || 0,
        lsb: lsbs[gid] || 0,
        xMin: isFinite(xMin) ? xMin : 0
      });
    }
  } else {
    for (let gid = 0; gid < numGlyphs; gid++) {
      glyphs.push({ contours: [], advance: advances[gid] || 0, lsb: lsbs[gid] || 0, xMin: 0 });
    }
  }

  return { unitsPerEm, ascender, descender, numGlyphs, cmap, glyphs };
}

function parseSimpleGlyph(r: R, off: number): TTGlyph | null {
  const n = r.i16(off);
  if (n <= 0) return null;
  const xMin = r.i16(off + 2);
  const endPts: number[] = [];
  let p = off + 10;
  for (let i = 0; i < n; i++) { endPts.push(r.u16(p)); p += 2; }
  const numPts = endPts[n - 1] + 1;
  const instrLen = r.u16(p);
  p += 2 + instrLen;
  const flags: number[] = [];
  while (flags.length < numPts) {
    const f = r.u8(p++);
    flags.push(f);
    if (f & 8) { let rep = r.u8(p++); while (rep--) flags.push(f); }
  }
  const xs: number[] = []; let x = 0;
  for (const f of flags) {
    if (f & 2) { const d = r.u8(p++); x += f & 16 ? d : -d; }
    else if (!(f & 16)) { x += r.i16(p); p += 2; }
    xs.push(x);
  }
  const ys: number[] = []; let y = 0;
  for (const f of flags) {
    if (f & 4) { const d = r.u8(p++); y += f & 32 ? d : -d; }
    else if (!(f & 32)) { y += r.i16(p); p += 2; }
    ys.push(y);
  }
  const pts: TTPoint[] = [];
  for (let i = 0; i < numPts; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
  const contours: TTPoint[][] = [];
  let s = 0;
  for (const e of endPts) { contours.push(pts.slice(s, e + 1)); s = e + 1; }
  return { contours, advance: 0, lsb: 0, xMin };
}

export interface BuildGlyph { advance: number; lsb: number; contours: TTPoint[][] }

export function buildSubstituteTTF(opts: {
  unitsPerEm: number; ascender: number; descender: number;
  glyphs: BuildGlyph[]; cmap: Array<[number, number]>;
}): Uint8Array {
  const glyphs = opts.glyphs;
  const numGlyphs = glyphs.length;

  const glyf = encodeGlyf(glyphs);
  const locaW = new W();
  glyf.loca.forEach((o) => locaW.u32(o));

  let advMax = 0;
  const hmtxW = new W();
  glyphs.forEach((g) => {
    hmtxW.u16(g.advance);
    hmtxW.i16(g.lsb);
    advMax = Math.max(advMax, g.advance);
  });

  const cmapW = buildCmap4(opts.cmap);

  const headW = new W();
  headW.u32(0x00010000); headW.u32(0x00010000);
  headW.u32(0); headW.u32(0x5F0F3CF5);
  headW.u16(0x000B); headW.u16(opts.unitsPerEm);
  headW.u32(0); headW.u32(0); headW.u32(0); headW.u32(0);
  headW.i16(glyf.xMin); headW.i16(glyf.yMin);
  headW.i16(glyf.xMax); headW.i16(glyf.yMax);
  headW.u16(0); headW.u16(8); headW.i16(2); headW.u16(1); headW.u16(0);

  const hheaW = new W();
  hheaW.u32(0x00010000);
  hheaW.i16(opts.ascender); hheaW.i16(opts.descender); hheaW.i16(0);
  hheaW.u16(advMax);
  hheaW.i16(glyf.xMin); hheaW.i16(glyf.yMin); hheaW.i16(glyf.xMax);
  hheaW.i16(1); hheaW.i16(0); hheaW.i16(0);
  hheaW.i16(0); hheaW.i16(0); hheaW.i16(0); hheaW.i16(0);
  hheaW.i16(0);
  hheaW.u16(numGlyphs);

  const maxpW = new W();
  maxpW.u32(0x00010000);
  maxpW.u16(numGlyphs);
  maxpW.u16(0); maxpW.u16(0); maxpW.u16(0); maxpW.u16(0);
  maxpW.u16(1);
  maxpW.u16(0); maxpW.u16(0); maxpW.u16(0); maxpW.u16(0);
  maxpW.u16(0); maxpW.u16(0); maxpW.u16(0); maxpW.u16(0);
  maxpW.u16(0);

  const tables: Array<[string, Uint8Array]> = [
    ["cmap", cmapW], ["glyf", glyf.data], ["head", headW.bytes()],
    ["hhea", hheaW.bytes()], ["hmtx", hmtxW.bytes()],
    ["loca", locaW.bytes()], ["maxp", maxpW.bytes()]
  ];

  const dirSize = 12 + 16 * tables.length;
  const out = new W();
  out.u32(0x00010000);
  out.u16(tables.length);
  const sc = Math.floor(Math.log2(tables.length));
  out.u16(16 * (1 << sc)); out.u16(sc); out.u16(tables.length * 16 - (1 << sc) * 16);
  let offset = dirSize;
  tables.forEach(([tag, d]) => {
    out.u8(tag.charCodeAt(0)); out.u8(tag.charCodeAt(1));
    out.u8(tag.charCodeAt(2)); out.u8(tag.charCodeAt(3));
    out.u32(0); out.u32(offset); out.u32(d.length);
    offset += Math.ceil(d.length / 4) * 4;
  });
  tables.forEach(([, d]) => { out.raw(d); out.pad4(); });
  return out.bytes();
}

function encodeGlyf(glyphs: BuildGlyph[]): {
  data: Uint8Array; loca: number[];
  xMin: number; yMin: number; xMax: number; yMax: number;
} {
  const w = new W();
  const loca: number[] = [];
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0;
  for (const g of glyphs) {
    loca.push(w.b.length);
    if (!g.contours.length) continue;
    const pts: TTPoint[] = [];
    const endPts: number[] = [];
    g.contours.forEach((c) => { c.forEach((pt) => pts.push(pt)); endPts.push(pts.length - 1); });
    let gx0 = 32767, gy0 = 32767, gx1 = -32768, gy1 = -32768;
    pts.forEach((pt) => {
      gx0 = Math.min(gx0, pt.x); gx1 = Math.max(gx1, pt.x);
      gy0 = Math.min(gy0, pt.y); gy1 = Math.max(gy1, pt.y);
    });
    xMin = Math.min(xMin, gx0); xMax = Math.max(xMax, gx1);
    yMin = Math.min(yMin, gy0); yMax = Math.max(yMax, gy1);
    const gw = new W();
    gw.u16(g.contours.length);
    gw.i16(gx0); gw.i16(gy0); gw.i16(gx1); gw.i16(gy1);
    endPts.forEach((e) => gw.u16(e));
    gw.u16(0);
    const flags: number[] = [];
    const xb: Array<{ v: number; long: boolean }> = [];
    const yb: Array<{ v: number; long: boolean }> = [];
    let px = 0, py = 0;
    for (const pt of pts) {
      let f = pt.on ? 1 : 0;
      const dx = pt.x - px, dy = pt.y - py;
      px = pt.x; py = pt.y;
      if (dx === 0) f |= 16;
      else if (dx > 0 && dx <= 255) { f |= 2 | 16; xb.push({ v: dx, long: false }); }
      else xb.push({ v: dx, long: true });
      if (dy === 0) f |= 32;
      else if (dy > 0 && dy <= 255) { f |= 4 | 32; yb.push({ v: dy, long: false }); }
      else yb.push({ v: dy, long: true });
      flags.push(f);
    }
    flags.forEach((f) => gw.u8(f));
    xb.forEach((d) => d.long ? gw.i16(d.v) : gw.u8(d.v));
    yb.forEach((d) => d.long ? gw.i16(d.v) : gw.u8(d.v));
    w.raw(gw.b);
    w.pad4();
  }
  loca.push(w.b.length);
  return { data: w.bytes(), loca, xMin, yMin, xMax, yMax };
}

function buildCmap4(pairs: Array<[number, number]>): Uint8Array {
  const sorted = pairs.filter(([u]) => u > 0 && u <= 0xffff).sort((a, b) => a[0] - b[0]);
  const segs: Array<{ start: number; end: number; delta: number }> = [];
  for (const [u, g] of sorted) {
    const last = segs[segs.length - 1];
    const delta = (g - u) & 0xffff;
    if (last && last.end === u - 1 && last.delta === delta) last.end = u;
    else segs.push({ start: u, end: u, delta });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const segCount = segs.length;
  const w = new W();
  w.u16(0); w.u16(1);
  w.u16(3); w.u16(1); w.u32(12);
  w.u16(4); w.u16(16 + 8 * segCount); w.u16(0);
  w.u16(2 * segCount);
  const lg = Math.floor(Math.log2(segCount));
  w.u16(2 * (1 << lg)); w.u16(lg); w.u16(2 * segCount - 2 * (1 << lg));
  segs.forEach((s) => w.u16(s.end));
  w.u16(0);
  segs.forEach((s) => w.u16(s.start));
  segs.forEach((s) => w.u16(s.delta));
  for (let i = 0; i < segCount; i++) w.u16(0);
  return w.bytes();
}