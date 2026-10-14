// The text and title of a PDF, read back with pdf.js (tests only).
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

export async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' '));
  return { title: (await doc.getMetadata()).info.Title, text: out.join(' ').replace(/\s+/g, ' ') };
}
