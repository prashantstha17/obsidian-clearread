import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream
} from "pdf-lib";
import { parseTTF, buildSubstituteTTF, TTFont, TTPoint } from "./ttf";
import { parseToUnicode } from "./tounicode";
import { fillBaseEncoding, glyphNameToUnicode, WINANSI } from "./encodings";

export interface TransformStats {
  fontsSeen: number;
  fontsSwapped: number;
  skipped: string[];
}

type Decoder = (raw: Uint8Array) => string;

export async function transformPdf(
  input: Uint8Array,
  fonts: TTFont[],
  onProgress?: (msg: string) => void
): Promise<{ bytes: Uint8Array; stats: TransformStats; pageTexts: string[] }> {
  onProgress?.("Loading PDF structure...");
  const doc = await PDFDocument.load(input, {
    ignoreEncryption: true,
    updateMetadata: false
  });
  const ctx: any = doc.context;
  const stats: TransformStats = { fontsSeen: 0, fontsSwapped: 0, skipped: [] };
  const processed = new Set<string>();
  const fontRefs: PDFRef[] = [];

  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    if (!res) continue;
    const fontsDict = res.lookup(PDFName.of("Font"));
    if (!(fontsDict instanceof PDFDict)) continue;
    for (const [, val] of fontsDict.entries()) {
      if (val instanceof PDFRef && !processed.has(val.toString())) {
        processed.add(val.toString());
        fontRefs.push(val);
      }
    }
  }

  for (const ref of fontRefs) {
    stats.fontsSeen++;
    await yieldUI();
    try {
      const fd = ctx.lookup(ref) as PDFDict;
      const subtype = String(fd.get(PDFName.of("Subtype")));
      if (subtype === "/Type0") {
        if (swapType0(ctx, fd, fonts, stats, onProgress)) stats.fontsSwapped++;
      } else if (subtype === "/TrueType" || subtype === "/Type1") {
        if (swapSimple(ctx, fd, fonts, stats)) stats.fontsSwapped++;
      }
    } catch (e) {
      stats.skipped.push(`${ref}: ${String(e)}`);
      console.warn("[ClearRead] font swap failed", ref, e);
    }
  }

  onProgress?.("Saving transformed PDF...");
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, stats, pageTexts: [] };
}

function num(v: any): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(String(v));
  return isFinite(n) ? n : undefined;
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, v));
}

function selfCheck(ttf: Uint8Array, expectedUpem: number): void {
  const check = parseTTF(ttf, false);
  if (check.unitsPerEm !== expectedUpem || check.numGlyphs === 0) {
    console.warn(
      "[ClearRead] TTF self-check failed: unitsPerEm", check.unitsPerEm,
      "expected", expectedUpem, "numGlyphs", check.numGlyphs
    );
  }
}

function findGlyph(
  fonts: TTFont[], uni: number
): { contours: TTPoint[][]; advance: number; upem: number } | null {
  for (const f of fonts) {
    const gid = f.cmap.get(uni);
    if (gid === undefined) continue;
    const g = f.glyphs[gid];
    if (g && g.contours.length) {
      return { contours: g.contours, advance: g.advance, upem: f.unitsPerEm };
    }
  }
  return null;
}

function isMathy(uni: number): boolean {
  return (
    (uni >= 0x0370 && uni <= 0x03ff) ||
    (uni >= 0x2100 && uni <= 0x214f) ||
    (uni >= 0x2190 && uni <= 0x21ff) ||
    (uni >= 0x2200 && uni <= 0x22ff) ||
    (uni >= 0x2300 && uni <= 0x23ff) ||
    (uni >= 0x2500 && uni <= 0x257f) ||
    (uni >= 0x2600 && uni <= 0x26ff) ||
    (uni >= 0x2700 && uni <= 0x27bf) ||
    (uni >= 0x1d400 && uni <= 0x1d7ff)
  );
}

function mathyRatio(map: Map<number, number>): number {
  let total = 0;
  let mathy = 0;
  map.forEach((u) => {
    total++;
    if (isMathy(u)) mathy++;
  });
  return total ? mathy / total : 0;
}

function isMathyName(fd: PDFDict): boolean {
  return /CMMI|CMSY|CMEX|MSAM|MSBM|Math|Symbol|Extra/i.test(
    String(fd.get(PDFName.of("BaseFont")))
  );
}

function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function yieldUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------- Type1 program encoding parser ----------------

function parseType1Encoding(fontBytes: Uint8Array): Map<number, number> | null {
  const s = bytesToLatin1(fontBytes);
  const cut = s.indexOf("currentfile eexec");
  const text = cut >= 0 ? s.slice(0, cut) : s;
  if (!/\/Encoding/.test(text)) return null;

  const map = new Map<number, number>();
  const re = /dup\s+(?:0x([0-9A-Fa-f]+)|16#([0-9A-Fa-f]+)|(\d+))\s+\/([A-Za-z0-9_.]+)\s+put/g;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(text))) {
    const code = m[1] !== undefined
      ? parseInt(m[1], 16)
      : m[2] !== undefined
        ? parseInt(m[2], 16)
        : parseInt(m[3], 10);
    const uni = glyphNameToUnicode(m[4]);
    if (uni !== undefined && code >= 0 && code <= 255) {
      map.set(code, uni);
      found = true;
    }
  }
  if (!found) return null;

  const full = new Map<number, number>();
  for (let c = 0; c < 256; c++) full.set(c, map.get(c) ?? c);
  return full;
}

function ot1Heuristic(): Map<number, number> {
  const m = new Map<number, number>();
  for (let c = 0; c < 256; c++) m.set(c, c);
  m.set(0x7b, 0x2013);
  m.set(0x7c, 0x2014);
  m.set(0x60, 0x2018);
  m.set(0x27, 0x2019);
  m.set(0x22, 0x201d);
  m.set(0x0b, 0xfb00);
  m.set(0x0c, 0xfb01);
  m.set(0x0d, 0xfb02);
  m.set(0x0e, 0xfb03);
  m.set(0x0f, 0xfb04);
  m.set(0x10, 0x69);
  m.set(0x11, 0x6a);
  return m;
}

function simpleCodeToUni(ctx: any, fd: PDFDict): Map<number, number> | null {
  const tu = fd.lookup(PDFName.of("ToUnicode"));
  if (tu && (tu as PDFRawStream).getContents) {
    const m = parseToUnicode(bytesToLatin1((tu as PDFRawStream).getContents()));
    if (m.size) return m;
  }

  const encRaw = fd.get(PDFName.of("Encoding"));
  const enc = encRaw instanceof PDFRef ? ctx.lookup(encRaw) : encRaw;
  if (enc instanceof PDFDict) {
    const m = new Map<number, number>();
    fillBaseEncoding(m, String(enc.get(PDFName.of("BaseEncoding")) || "/StandardEncoding"));
    const diffs = enc.lookup(PDFName.of("Differences"));
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const el = diffs.get(i);
        const s = String(el);
        if (s.startsWith("/")) {
          const u = glyphNameToUnicode(s);
          if (u !== undefined) m.set(code, u);
          code++;
        } else {
          code = num(el) ?? 0;
        }
      }
    }
    return m;
  }
  if (enc) {
    const m = new Map<number, number>();
    fillBaseEncoding(m, String(enc));
    return m;
  }

  const subtype = String(fd.get(PDFName.of("Subtype")));
  if (subtype === "/Type1") {
    const descRef = fd.get(PDFName.of("FontDescriptor"));
    const desc = descRef ? (ctx.lookup(descRef as PDFRef) as PDFDict) : null;
    const ffRef = desc?.get(PDFName.of("FontFile"));
    if (ffRef instanceof PDFRef) {
      const stream = ctx.lookup(ffRef) as PDFRawStream;
      if (stream && (stream as PDFRawStream).getContents) {
        const m = parseType1Encoding((stream as PDFRawStream).getContents());
        if (m) return m;
      }
    }
    if (/^CM|^LMRoman|OT1/i.test(String(fd.get(PDFName.of("BaseFont"))))) {
      return ot1Heuristic();
    }
  }

  const m = new Map<number, number>();
  fillBaseEncoding(m, "/WinAnsiEncoding");
  return m;
}

// NEW: write an /Encoding dict that exactly matches the mapping we used,
// so PDF.js charcode -> unicode -> cmap all agree.
function buildEncodingDict(ctx: any, codeToUni: Map<number, number>): PDFDict {
  const dict = PDFDict.withContext(ctx);
  dict.set(PDFName.of("BaseEncoding"), PDFName.of("WinAnsiEncoding"));
  const diffs = PDFArray.withContext(ctx);
  for (let c = 0; c < 256; c++) {
    const u = codeToUni.get(c);
    if (u === undefined || u > 0xffff || u < 0x20) continue;
    const win = WINANSI[c] ?? c;
    if (u === win) continue;
    diffs.push(PDFNumber.of(c));
    diffs.push(PDFName.of(`uni${u.toString(16).toUpperCase().padStart(4, "0")}`));
  }
  if (diffs.size() > 0) dict.set(PDFName.of("Differences"), diffs);
  return dict;
}

function swapType0(
  ctx: any, fd: PDFDict, fonts: TTFont[],
  stats: TransformStats, onProgress?: (m: string) => void
): boolean {
  if (String(fd.get(PDFName.of("Encoding"))) !== "/Identity-H") {
    stats.skipped.push("Type0 encoding not Identity-H");
    return false;
  }
  const tuStream = fd.lookup(PDFName.of("ToUnicode"));
  if (!tuStream || !(tuStream as PDFRawStream).getContents) {
    stats.skipped.push("Type0 missing ToUnicode");
    return false;
  }
  const gidToUni = parseToUnicode(
    bytesToLatin1((tuStream as PDFRawStream).getContents())
  );
  if (!gidToUni.size) {
    stats.skipped.push("Type0 empty ToUnicode");
    return false;
  }

  const descArr = fd.lookup(PDFName.of("DescendantFonts"));
  if (!(descArr instanceof PDFArray)) {
    stats.skipped.push("Type0 no DescendantFonts");
    return false;
  }
  const cid = ctx.lookup(descArr.get(0)) as PDFDict;
  if (String(cid.get(PDFName.of("Subtype"))) !== "/CIDFontType2") {
    stats.skipped.push("Type0 not CIDFontType2");
    return false;
  }
  const fdRef = cid.get(PDFName.of("FontDescriptor"));
  const fdesc = fdRef ? (ctx.lookup(fdRef as PDFRef) as PDFDict) : null;
  const ff2Ref = fdesc?.get(PDFName.of("FontFile2"));
  if (!ff2Ref || !(ff2Ref instanceof PDFRef)) {
    stats.skipped.push("Type0 no FontFile2");
    return false;
  }

  const orig = parseTTF((ctx.lookup(ff2Ref) as PDFRawStream).getContents(), true);

  onProgress?.("Building substitute font (CID)...");

  const glyphs = [];
  const cmapPairs: Array<[number, number]> = [];
  let substituted = 0;
  let fellBack = 0;

  for (let gid = 0; gid < orig.numGlyphs; gid++) {
    const og = orig.glyphs[gid];
    const uni = gidToUni.get(gid);
    let contours: TTPoint[][] = [];

    const hit = uni !== undefined ? findGlyph(fonts, uni) : null;
    if (hit) {
      const scale = orig.unitsPerEm / hit.upem;
      let xMin = Infinity;
      hit.contours.forEach((c) => c.forEach((p) => { xMin = Math.min(xMin, p.x * scale); }));
      const shift = og.lsb - (isFinite(xMin) ? xMin : 0);
      contours = hit.contours.map((c) => c.map((p) => ({
        x: Math.round(clamp16(p.x * scale + shift)),
        y: Math.round(clamp16(p.y * scale)),
        on: p.on
      })));
      cmapPairs.push([uni!, gid]);
      substituted++;
    } else if (og.contours.length) {
      contours = og.contours;
      fellBack++;
    }

    glyphs.push({ advance: og.advance, lsb: og.lsb, contours });
  }

  const ttf = buildSubstituteTTF({
    unitsPerEm: orig.unitsPerEm,
    ascender: orig.ascender,
    descender: orig.descender,
    glyphs,
    cmap: cmapPairs
  });
  selfCheck(ttf, orig.unitsPerEm);

  const newStream = ctx.flateStream(ttf);
  newStream.dict.set(PDFName.of("Length1"), PDFNumber.of(ttf.length));
  ctx.assign(ff2Ref, newStream);

  console.log(`[ClearRead] Type0: substituted ${substituted}, kept original ${fellBack}`);
  return true;
}

function swapSimple(
  ctx: any, fd: PDFDict, fonts: TTFont[], stats: TransformStats
): boolean {
  if (isMathyName(fd)) {
    stats.skipped.push("simple: math/symbol font left original");
    return false;
  }

  const codeToUni = simpleCodeToUni(ctx, fd);
  if (!codeToUni || !codeToUni.size) {
    stats.skipped.push("simple: no encoding info");
    return false;
  }
  if (mathyRatio(codeToUni) > 0.25) {
    stats.skipped.push("simple: math-heavy encoding left original");
    return false;
  }

  const first = num(fd.get(PDFName.of("FirstChar"))) ?? 32;
  const last = num(fd.get(PDFName.of("LastChar"))) ?? 255;
  const widthsArr = fd.lookup(PDFName.of("Widths")) as PDFArray | undefined;

  const primary = fonts[0];
  const upem = 1000;
  const glyphs = [];
  const cmapPairs: Array<[number, number]> = [];

  for (let code = 0; code <= last; code++) {
    if (code < first) {
      glyphs.push({ advance: 0, lsb: 0, contours: [] });
      continue;
    }
    const uni = codeToUni.get(code);
    const width = widthsArr ? num(widthsArr.get(code - first)) : undefined;

    let contours: TTPoint[][] = [];
    let advance = width ?? 500;
    let lsb = 0;

    const hit = uni !== undefined ? findGlyph(fonts, uni) : null;
    if (hit) {
      const scale = upem / hit.upem;
      let xMin = Infinity;
      contours = hit.contours.map((c) => c.map((p) => {
        const x = clamp16(p.x * scale);
        const y = clamp16(p.y * scale);
        xMin = Math.min(xMin, x);
        return { x: Math.round(x), y: Math.round(y), on: p.on };
      }));
      if (!isFinite(xMin)) xMin = 0;
      lsb = Math.round(xMin);
      if (width === undefined) advance = Math.round(hit.advance * scale);
      cmapPairs.push([uni, code]);
    }
    glyphs.push({ advance, lsb, contours });
  }

  const scale0 = upem / primary.unitsPerEm;
  const ttf = buildSubstituteTTF({
    unitsPerEm: upem,
    ascender: Math.round(primary.ascender * scale0),
    descender: Math.round(primary.descender * scale0),
    glyphs,
    cmap: cmapPairs
  });
  selfCheck(ttf, upem);

  const ffRef = ctx.nextRef();
  const stream = ctx.flateStream(ttf);
  stream.dict.set(PDFName.of("Length1"), PDFNumber.of(ttf.length));
  ctx.assign(ffRef, stream);

  let descRef = fd.get(PDFName.of("FontDescriptor"));
  let desc = descRef ? (ctx.lookup(descRef as PDFRef) as PDFDict) : null;
  if (!desc) {
    desc = PDFDict.withContext(ctx);
    descRef = ctx.nextRef();
    ctx.assign(descRef as PDFRef, desc);
    fd.set(PDFName.of("FontDescriptor"), descRef);
    desc.set(
      PDFName.of("FontName"),
      fd.get(PDFName.of("BaseFont")) || PDFName.of("ClearReadSub")
    );
    desc.set(PDFName.of("Flags"), PDFNumber.of(32));
    const bbox = PDFArray.withContext(ctx);
    [-200, -300, 1200, 1000].forEach((n) => bbox.push(PDFNumber.of(n)));
    desc.set(PDFName.of("FontBBox"), bbox);
    desc.set(PDFName.of("Ascent"), PDFNumber.of(Math.round(primary.ascender * scale0)));
    desc.set(PDFName.of("Descent"), PDFNumber.of(Math.round(primary.descender * scale0)));
  }

  desc.delete(PDFName.of("FontFile"));
  desc.delete(PDFName.of("FontFile3"));
  desc.set(PDFName.of("FontFile2"), ffRef);

  fd.set(PDFName.of("Subtype"), PDFName.of("TrueType"));

  // KEY FIX: encoding must match the mapping we substituted with
  fd.set(PDFName.of("Encoding"), buildEncodingDict(ctx, codeToUni));

  return true;
}

// ---------------- lazy text extraction (audio) ----------------

function buildDecoder(ctx: any, fd: PDFDict): Decoder | null {
  const subtype = String(fd.get(PDFName.of("Subtype")));
  if (subtype === "/Type0") {
    const tuStream = fd.lookup(PDFName.of("ToUnicode"));
    if (!tuStream || !(tuStream as PDFRawStream).getContents) return null;
    const gidToUni = parseToUnicode(bytesToLatin1((tuStream as PDFRawStream).getContents()));
    if (!gidToUni.size) return null;
    return (raw) => {
      let out = "";
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const gid = (raw[i] << 8) | raw[i + 1];
        const u = gidToUni.get(gid);
        if (u !== undefined) out += String.fromCodePoint(u);
      }
      return out;
    };
  }

  const codeToUni = simpleCodeToUni(ctx, fd);
  if (!codeToUni) return null;
  return (raw) => {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      const u = codeToUni.get(raw[i]);
      if (u !== undefined) out += String.fromCodePoint(u);
    }
    return out;
  };
}

function unescapePdfString(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const n = s[++i];
      if (n >= "0" && n <= "7") {
        let oct = n;
        while (oct.length < 3 && i + 1 < s.length && s[i + 1] >= "0" && s[i + 1] <= "7") {
          oct += s[++i];
        }
        bytes.push(parseInt(oct, 8) & 255);
      } else {
        const map: Record<string, number> = {
          n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92
        };
        bytes.push(map[n] ?? n.charCodeAt(0));
      }
    } else {
      bytes.push(ch.charCodeAt(0) & 255);
    }
  }
  return new Uint8Array(bytes);
}

function hexToBytes(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.substr(i, 2), 16));
  }
  if (clean.length % 2) out.push(parseInt(clean[clean.length - 1], 16) << 4);
  return new Uint8Array(out);
}

interface Tok { type: "str" | "hex" | "name" | "num" | "kw"; value: string; bytes?: Uint8Array }

function tokenizeContent(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      i++;
      let raw = "";
      while (i < n && depth > 0) {
        const c = s[i];
        if (c === "\\") { raw += c + (s[i + 1] ?? ""); i += 2; continue; }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        raw += c;
        i++;
      }
      toks.push({ type: "str", value: raw, bytes: unescapePdfString(raw) });
      continue;
    }
    if (ch === "<") {
      if (s[i + 1] === "<") { i += 2; toks.push({ type: "kw", value: "<<" }); continue; }
      let j = i + 1;
      let hex = "";
      while (j < n && s[j] !== ">") { hex += s[j]; j++; }
      i = j + 1;
      toks.push({ type: "hex", value: hex, bytes: hexToBytes(hex) });
      continue;
    }
    if (ch === ">") {
      if (s[i + 1] === ">") { i += 2; toks.push({ type: "kw", value: ">>" }); continue; }
      i++;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      let name = "";
      while (j < n && !/[\s\/\(\)<>\[\]\{\}%]/.test(s[j])) { name += s[j]; j++; }
      i = j;
      toks.push({ type: "name", value: name });
      continue;
    }
    if (ch === "[" || ch === "]") {
      toks.push({ type: "kw", value: ch });
      i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    let word = "";
    while (j < n && !/[\s\/\(\)<>\[\]\{\}%]/.test(s[j])) { word += s[j]; j++; }
    i = j;
    if (/^[+\-]?[\d.]+$/.test(word)) toks.push({ type: "num", value: word });
    else toks.push({ type: "kw", value: word });
  }
  return toks;
}

function interpretText(toks: Tok[], decoders: Map<string, Decoder>): string {
  const out: string[] = [];
  let inText = false;
  let cur: Decoder | null = null;
  let pendingName: string | null = null;
  for (const t of toks) {
    if (t.type === "kw") {
      if (t.value === "BT") { inText = true; out.push(" "); }
      else if (t.value === "ET") inText = false;
      else if (t.value === "Tf") cur = pendingName ? (decoders.get("/" + pendingName) ?? null) : null;
      else if (t.value === "T*" || t.value === "Td" || t.value === "TD") out.push(" ");
    } else if (t.type === "name") {
      pendingName = t.value;
    } else if ((t.type === "str" || t.type === "hex") && inText && cur && t.bytes) {
      out.push(cur(t.bytes));
    }
  }
  return out.join("").replace(/\s{2,}/g, " ").trim();
}

export async function extractPageTexts(
  doc: PDFDocument,
  onProgress?: (m: string) => void
): Promise<string[]> {
  const ctx: any = doc.context;
  const pages = doc.getPages();
  const texts: string[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    try {
      const decoders = new Map<string, Decoder>();
      const res = page.node.Resources();
      const fonts = res?.lookup(PDFName.of("Font"));
      if (fonts instanceof PDFDict) {
        for (const [key, val] of fonts.entries()) {
          const fd = val instanceof PDFRef ? ctx.lookup(val) : val;
          if (fd instanceof PDFDict) {
            const d = buildDecoder(ctx, fd);
            if (d) decoders.set(key.toString(), d);
          }
        }
      }
      let raw = "";
      const contents = page.node.lookup(PDFName.of("Contents"));
      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i++) {
          const s = ctx.lookup(contents.get(i));
          if (s && (s as PDFRawStream).getContents) {
            raw += bytesToLatin1((s as PDFRawStream).getContents());
          }
        }
      } else if (contents && (contents as PDFRawStream).getContents) {
        raw = bytesToLatin1((contents as PDFRawStream).getContents());
      }
      texts.push(raw ? interpretText(tokenizeContent(raw), decoders) : "");
    } catch (e) {
      texts.push("");
    }
    if (pi % 10 === 0) {
      onProgress?.(`Extracting text: page ${pi + 1}/${pages.length}`);
      await yieldUI();
    }
  }
  return texts;
}