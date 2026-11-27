const { copyFile, mkdir } = require('node:fs/promises')
const path = require('node:path')

async function build(esbuildDirectory, outputDirectory, mode = 'production') {
  const entries = {
    production: 'backend/node_api/src/scripts/neon-worker.js',
    proof: 'ops/neon-direct-worker-poc/index.mjs',
    'connection-audit': 'ops/neon-direct-worker-poc/connection-audit.mjs',
  }
  if (!esbuildDirectory || !outputDirectory || !Object.hasOwn(entries, mode)) {
    throw Error('Pass the installed esbuild directory, a staging directory, and optionally proof or connection-audit')
  }
  const esbuild = require(path.resolve(esbuildDirectory))
  const packages = path.resolve('backend/node_api/node_modules')
  const output = path.resolve(outputDirectory)
  await mkdir(output, { recursive: true })

  await esbuild.build({
    entryPoints: [entries[mode]],
    outfile: path.join(output, 'index.mjs'),
    nodePaths: [packages],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: { js: [
      "import { createRequire as bundleCreateRequire } from 'node:module'",
      "import { fileURLToPath as bundleFilePath } from 'node:url'",
      "import { dirname as bundleDirname } from 'node:path'",
      'const require = bundleCreateRequire(import.meta.url)',
      'const __filename = bundleFilePath(import.meta.url)',
      'const __dirname = bundleDirname(__filename)',
    ].join(';\n') + ';' },
    plugins: [{
      name: 'neon-pdf-assets',
      setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({
          path: './pdf.mjs', external: true,
        }))
      },
    }],
  })

  await Promise.all([
    ...['schema.sql', 'deployment.sql'].map(name =>
      copyFile(path.resolve('backend/node_api/src/config', name), path.join(output, name))),
    ...['pdf.mjs', 'pdf.worker.mjs'].map(name =>
      copyFile(path.join(packages, 'pdfjs-dist/legacy/build', name), path.join(output, name))),
  ])
}

build(...process.argv.slice(2)).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
