import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function toText(chunks, withTs) {
  return withTs
    ? chunks.map((c) => `[${fmtTime(c.start)}] ${c.text}`).join('\n')
    : chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function saveTxt(text, base) {
  download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
}

export async function saveDocx(text, base) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: `Transkript: ${base}`, heading: HeadingLevel.HEADING_1 }),
        ...text.split('\n').map((line) => {
          const m = line.match(/^(\[\d{2}:\d{2}:\d{2}\])\s?(.*)$/);
          return new Paragraph({
            spacing: { after: 120 },
            children: m
              ? [new TextRun({ text: m[1] + ' ', bold: true, color: '7C3AED' }), new TextRun(m[2])]
              : [new TextRun(line)],
          });
        }),
      ],
    }],
  });
  download(await Packer.toBlob(doc), `${base}.docx`);
}
