export function parseToUnicode(text: string): Map<number, number> {
  const map = new Map<number, number>();
  const readHex = (s: string) => parseInt(s, 16);
  const dstToUni = (hex: string): number => {
    if (hex.length <= 4) return readHex(hex);
    if (hex.length === 8) {
      const hi = readHex(hex.slice(0, 4)), lo = readHex(hex.slice(4));
      if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
        return 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
      }
      return hi;
    }
    return readHex(hex.slice(0, 4));
  };
  const charRe = /beginbfchar\s*([\s\S]*?)\s*endbfchar/g;
  let m: RegExpExecArray | null;
  while ((m = charRe.exec(text))) {
    const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(m[1]))) map.set(readHex(lm[1]), dstToUni(lm[2]));
  }
  const rangeRe = /beginbfrange\s*([\s\S]*?)\s*endbfrange/g;
  while ((m = rangeRe.exec(text))) {
    const lineRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(m[1]))) {
      const lo = readHex(lm[1]);
      const hi = readHex(lm[2]);
      if (lm[3] && lm[3].startsWith("<")) {
        let uni = dstToUni(lm[4]);
        for (let c = lo; c <= hi; c++) map.set(c, uni++);
      } else if (lm[5]) {
        const vals = [...lm[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => dstToUni(x[1]));
        for (let c = lo; c <= hi && c - lo < vals.length; c++) map.set(c, vals[c - lo]);
      }
    }
  }
  return map;
}