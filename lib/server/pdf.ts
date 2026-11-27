// Minimal text PDF writer (PDF 1.4, standard Helvetica fonts, A4). Enough for
// incident reports handed to rescue teams, police and the Ministry; avoids a
// new dependency. Text outside Latin-1 is transliterated.
export type PdfLine = { text: string; bold?: boolean; size?: number; gap?: number };
const W = 595, H = 842, M = 50;
function latin1(text: string) {
  return text
    .replace(/[→]/g, "->")
    .replace(/[≠]/g, "!=")
    .replace(/[·•]/g, "-")
    .replace(/[³]/g, "3")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}
const esc = (t: string) => latin1(t).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
function wrap(text: string, size: number) {
  const max = Math.floor((W - 2 * M) / (size * 0.5));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > max) {
        if (line) out.push(line);
        line = word.length > max ? word.slice(0, max) : word;
      } else line = (line + " " + word).trim();
    }
    out.push(line);
  }
  return out;
}
export function textPdf(title: string, lines: PdfLine[]): Buffer {
  const pages: string[] = [];
  let ops: string[] = [], y = H - M;
  const flush = () => {
    pages.push(ops.join("\n"));
    ops = [];
    y = H - M;
  };
  const footer = (n: number) => `BT /F1 8 Tf ${M} 25 Td (${esc(title)} - page ${n}) Tj ET`;
  for (const l of lines) {
    const size = l.size || 10;
    y -= l.gap || 0;
    for (const part of wrap(l.text, size)) {
      if (y < M + size) {
        ops.push(footer(pages.length + 1));
        flush();
      }
      y -= size * 1.35;
      ops.push(`BT /${l.bold ? "F2" : "F1"} ${size} Tf ${M} ${y.toFixed(1)} Td (${esc(part)}) Tj ET`);
    }
  }
  ops.push(footer(pages.length + 1));
  flush();
  const objects: string[] = [];
  const add = (s: string) => objects.push(s) - 1 + 1;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages placeholder
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const content of pages) {
    const stream = Buffer.from(content, "latin1");
    const c = add(`<< /Length ${stream.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  objects.push(`<< /Title (${esc(title)}) /Producer (Foresight) >>`);
  const info = objects.length;
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
