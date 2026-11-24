import { defineConfig } from 'vite'
import { gzipSync } from 'node:zlib'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default defineConfig({
  // 조사용 녹화 자료는 보존하고, 운영 화면에서 참조하는 자산만 빌드합니다.
  publicDir: false,
  plugins: [
    {
      name: 'precompress-assets',
      apply: 'build',
      async writeBundle({ dir }) {
        if (!dir) return
        const assets = join(dir, 'assets')
        for (const name of await readdir(assets)) {
          if (!/\.(js|mjs|wasm|onnx)$/.test(name)) continue
          const path = join(assets, name),
            source = await readFile(path)
          if (source.length >= 1024)
            await writeFile(path + '.gz', gzipSync(source, { level: 9 }))
        }
      },
    },
  ],
  worker: { format: 'es' },
  build: {
    rollupOptions: { input: ['index.html', 'cases/city-hall-survey.html'] },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8765' } },
})
