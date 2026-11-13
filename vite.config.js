import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// Files the editor loads at run time as they are, from node_modules: Pyodide (Python scripting) and
// the Basis Universal module (KTX2 textures). Served at /<route>/ during development and copied into
// the build, so both work offline.
const STATIC = [
  { route: 'pyodide', dir: path.resolve('node_modules/pyodide'), files: ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'] },
  { route: 'basis', dir: path.resolve('node_modules/ktx2-encoder/dist/basis'), files: ['basis_encoder.wasm'] },
];
const MIME = { '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json' };

function staticAssets() {
  return {
    name: 'rigby-static-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/([^/?]+)\/([^?]+)/.exec(req.url ?? '');
        const entry = m && STATIC.find((e) => e.route === m[1] && e.files.includes(m[2]));
        if (!entry) return next();
        res.setHeader('Content-Type', MIME[path.extname(m[2])] ?? 'application/octet-stream');
        fs.createReadStream(path.join(entry.dir, m[2])).pipe(res);
      });
    },
    generateBundle() {
      for (const { route, dir, files } of STATIC) for (const file of files) this.emitFile({ type: 'asset', fileName: `${route}/${file}`, source: fs.readFileSync(path.join(dir, file)) });
    },
  };
}

// The demo projects: bundled into the browser editor, downloaded from the website by the desktop app
// (Tauri sets TAURI_ENV_PLATFORM for its builds), which then carries no character artwork.
const demoSources = path.resolve(process.env.TAURI_ENV_PLATFORM ? 'src/editor/demo-sources-remote.js' : 'src/editor/demo-sources-bundled.js');

// The version shown in Help ▸ About (package.json is the one source of the version).
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

// Vite serves and bundles the editor UI; Tauri hosts it in a native window.
export default defineConfig({
  clearScreen: false,
  define: { __RIGBY_VERSION__: JSON.stringify(version) },
  resolve: { alias: { '@demo-sources': demoSources } },
  plugins: [staticAssets()],
  worker: { format: 'es' },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
    // The editor, the splash screen window and the detached panel windows (panel.html).
    rollupOptions: { input: { main: 'index.html', splash: 'splash.html', panel: 'panel.html' } },
  },
});
