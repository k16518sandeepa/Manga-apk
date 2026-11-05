// Opens comic containers and exposes a uniform page API:
//   { count, getPage(i) -> Promise<Blob>, close() }
// Supported: CBZ/ZIP, EPUB (image-based), CBR/RAR, CB7/7Z, CBT/TAR, PDF.

const IMG_RE = /\.(jpe?g|jfif|png|webp|gif|avif|bmp)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const natural = (a, b) => collator.compare(a, b);

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
};
const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'image/jpeg';

function skipPath(p) {
  const l = p.toLowerCase();
  return l.startsWith('__macosx/') || /(^|\/)\.[^/]/.test(l) || /thumbs\.db$/.test(l);
}

export const SUPPORTED_EXT = ['cbz', 'zip', 'cbr', 'rar', 'cb7', '7z', 'cbt', 'tar', 'epub', 'pdf'];

export function extOf(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

// Detect the real container from magic bytes (many .cbr files are really zips).
export async function sniff(blob, name = '') {
  const h = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const s = (o, l) => String.fromCharCode(...h.slice(o, o + l));
  if (s(0, 4) === '%PDF') return 'pdf';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  if (s(0, 4) === 'Rar!') return 'rar';
  if (h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf) return '7z';
  if (s(257, 5) === 'ustar') return 'tar';
  const byExt = { cbz: 'zip', zip: 'zip', epub: 'zip', cbr: 'rar', rar: 'rar', cb7: '7z', '7z': '7z', cbt: 'tar', tar: 'tar', pdf: 'pdf' };
  return byExt[extOf(name)] || null;
}

export async function openBook(blob, name = '') {
  const kind = await sniff(blob, name);
  if (!kind) throw new Error('Unsupported file type');
  switch (kind) {
    case 'zip': return openZip(blob, extOf(name) === 'epub');
    case 'tar': return openTar(blob);
    case 'rar':
    case '7z': return openLibarchive(blob);
    case 'pdf': return openPdf(blob);
  }
}

// ---------------- ZIP / CBZ / EPUB ----------------
async function openZip(blob, isEpub) {
  const zip = await window.JSZip.loadAsync(blob);
  const names = Object.values(zip.files)
    .filter((f) => !f.dir && IMG_RE.test(f.name) && !skipPath(f.name))
    .map((f) => f.name);

  let list = null;
  if (isEpub || zip.file('META-INF/container.xml')) {
    list = await epubOrder(zip, new Set(names)).catch(() => null);
  }
  if (!list || !list.length) list = names.sort(natural);
  if (!list.length) throw new Error('No images found in this file');

  return {
    count: list.length,
    async getPage(i) {
      const buf = await zip.file(list[i]).async('arraybuffer');
      return new Blob([buf], { type: mimeOf(list[i]) });
    },
    close() {},
  };
}

async function epubOrder(zip, imageSet) {
  const parse = (txt, type) => new DOMParser().parseFromString(txt, type);
  const container = parse(await zip.file('META-INF/container.xml').async('string'), 'application/xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) return null;
  const opf = parse(await zip.file(opfPath).async('string'), 'application/xml');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map();
  opf.querySelectorAll('manifest > item').forEach((it) => manifest.set(it.getAttribute('id'), it.getAttribute('href')));
  const resolve = (base, rel) => {
    try { return decodeURIComponent(new URL(rel, 'http://h/' + base).pathname.slice(1)); } catch { return null; }
  };

  const out = [];
  const seen = new Set();
  const add = (p) => { if (p && imageSet.has(p) && !seen.has(p)) { seen.add(p); out.push(p); } };

  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const href = manifest.get(ref.getAttribute('idref'));
    if (!href) continue;
    const pagePath = resolve(opfDir, href);
    const f = pagePath && zip.file(pagePath);
    if (!f) continue;
    const txt = await f.async('string');
    const doc = parse(txt, 'text/html');
    doc.querySelectorAll('img').forEach((im) => add(resolve(pagePath, im.getAttribute('src') || '')));
    // SVG <image> wrappers (very common in fixed-layout comics)
    const re = /<image[^>]+(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(txt))) add(resolve(pagePath, m[1]));
  }
  return out;
}

// ---------------- TAR / CBT ----------------
async function openTar(blob) {
  const dec = new TextDecoder();
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= blob.size) {
    const h = new Uint8Array(await blob.slice(off, off + 512).arrayBuffer());
    if (h.every((b) => b === 0)) break;
    const str = (o, l) => { let e = o; while (e < o + l && h[e] !== 0) e++; return dec.decode(h.subarray(o, e)); };
    let name = str(0, 100);
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = h[156];
    if (str(257, 5) === 'ustar') { const prefix = str(345, 155); if (prefix) name = prefix + '/' + name; }
    const dataOff = off + 512;
    if (type === 76 /* 'L' GNU long name */) {
      longName = dec.decode(new Uint8Array(await blob.slice(dataOff, dataOff + size).arrayBuffer())).replace(/\0+$/, '');
    } else if (type === 48 || type === 0) {
      if (longName) { name = longName; longName = null; }
      if (IMG_RE.test(name) && !skipPath(name)) entries.push({ name, off: dataOff, size });
    }
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  entries.sort((a, b) => natural(a.name, b.name));
  if (!entries.length) throw new Error('No images found in this file');
  return {
    count: entries.length,
    async getPage(i) {
      const e = entries[i];
      return new Blob([blob.slice(e.off, e.off + e.size)], { type: mimeOf(e.name) });
    },
    close() {},
  };
}

// ---------------- RAR / 7z via libarchive (WebAssembly) ----------------
let archiveReady = null;
async function openLibarchive(blob) {
  if (!archiveReady) {
    archiveReady = import('../vendor/libarchive/libarchive.js').then(({ Archive }) => {
      Archive.init({ workerUrl: new URL('../vendor/libarchive/worker-bundle.js', import.meta.url).href });
      return Archive;
    });
  }
  const Archive = await archiveReady;
  const ar = await Archive.open(blob);
  if ((await ar.hasEncryptedData()) === true) throw new Error('Password-protected archives are not supported');
  const arr = await ar.getFilesArray();
  const files = arr
    .map(({ file, path }) => ({ file, path: (path || '') + file.name }))
    .filter((f) => IMG_RE.test(f.path) && !skipPath(f.path))
    .sort((a, b) => natural(a.path, b.path));
  if (!files.length) throw new Error('No images found in this file');
  return {
    count: files.length,
    async getPage(i) {
      const f = await files[i].file.extract();
      return f.type ? f : new Blob([f], { type: mimeOf(files[i].path) });
    },
    close() { try { ar.close(); } catch {} },
  };
}

// ---------------- PDF ----------------
async function openPdf(blob) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  return {
    count: doc.numPages,
    async getPage(i) {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const target = Math.min(2200, Math.max(1200, Math.round(window.innerWidth * (window.devicePixelRatio || 1))));
      const vp = page.getViewport({ scale: target / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      page.cleanup();
      return out;
    },
    close() { try { doc.destroy(); } catch {} },
  };
}

// ---------------- cover thumbnails ----------------
export async function makeCover(pageBlob, width = 360) {
  let bmp;
  try {
    bmp = await createImageBitmap(pageBlob);
  } catch {
    const url = URL.createObjectURL(pageBlob);
    bmp = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    URL.revokeObjectURL(url);
  }
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, width / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}
