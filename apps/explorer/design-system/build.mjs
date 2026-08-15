// Build dist/: transpile the JSX sources to plain ESM and ship the hand-authored
// type contracts verbatim (types/index.d.ts is the API the design agent codes against).
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
const entries = readdirSync('src').filter(f => f.endsWith('.jsx'));
await build({
  entryPoints: entries.map(f => `src/${f}`),
  outdir: 'dist',
  format: 'esm',
  jsx: 'automatic',
  bundle: false,
  sourcemap: false,
  logLevel: 'info',
});
// esbuild with bundle:false keeps import specifiers verbatim; the emitted files are .js.
writeFileSync('dist/index.js', readFileSync('dist/index.js', 'utf8').replaceAll('.jsx"', '.js"'));
copyFileSync('types/index.d.ts', 'dist/index.d.ts');

// Compiled stylesheet for the converter's cssEntry: token files concatenated, with the
// Google Fonts @import hoisted first (CSS requires @import before any rules).
const order = ['tokens/typography.css', 'tokens/colors.css', 'tokens/structure.css'];
writeFileSync('dist/styles.css', order.map(f => readFileSync(f, 'utf8')).join('\n'));
