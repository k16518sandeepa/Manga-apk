// Copies third-party browser libraries from node_modules into www/vendor
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = (p) => path.join(root, 'www', 'vendor', p);

const files = [
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
  ['libarchive.js/dist/libarchive.js', 'libarchive/libarchive.js'],
  ['libarchive.js/dist/worker-bundle.js', 'libarchive/worker-bundle.js'],
  ['libarchive.js/dist/libarchive.wasm', 'libarchive/libarchive.wasm'],
];
for (const [src, dst] of files) {
  fs.mkdirSync(path.dirname(out(dst)), { recursive: true });
  fs.copyFileSync(nm(src), out(dst));
  console.log('vendor ←', dst);
}
