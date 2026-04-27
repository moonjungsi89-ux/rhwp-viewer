import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// 배포 환경별 base 경로:
//   Vercel / Netlify / 커스텀 도메인 → VITE_BASE 미설정 → '/'
//   GitHub Pages (레포 이름 경로)    → VITE_BASE='/rhwp-viewer/' 환경변수 설정
const BASE = process.env.VITE_BASE ?? '/';

/**
 * rhwp.js 내부의 `new URL('rhwp_bg.wasm', import.meta.url)` 구문이
 * Vite 정적 분석에 의해 dist/assets/에 중복 번들링되는 것을 방지.
 * 우리 코드는 BASE + 'rhwp_bg.wasm'을 명시적 경로로 사용하므로
 * 이 자동 생성 애셋은 불필요.
 */
function suppressRhwpWasmAsset(): Plugin {
  return {
    name: 'suppress-rhwp-wasm-asset',
    generateBundle(_opts, bundle) {
      for (const key of Object.keys(bundle)) {
        if (key.includes('rhwp_bg') && key.endsWith('.wasm')) {
          delete bundle[key];
        }
      }
    },
  };
}

/**
 * 빌드 완료 후 dist/sw.js의 PRECACHE_URLS 자리표시자를
 * 실제 hashed asset 경로 목록으로 교체.
 *
 * BASE가 '/'가 아닐 때(e.g. '/rhwp-viewer/')도 올바른 경로로 주입.
 * SW의 fetch 이벤트 URL은 항상 BASE를 포함한 전체 경로이므로 일치해야 함.
 */
function injectSwPrecache(): Plugin {
  return {
    name: 'inject-sw-precache',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      const swPath  = path.join(distDir, 'sw.js');
      if (!fs.existsSync(swPath)) return;

      // BASE가 '/rhwp-viewer/'면 URL도 '/rhwp-viewer/manifest.json' 등으로 생성
      const b = BASE.endsWith('/') ? BASE : `${BASE}/`;

      const staticUrls: string[] = [b, `${b}manifest.json`, `${b}rhwp_bg.wasm`];

      const iconsDir = path.join(distDir, 'icons');
      if (fs.existsSync(iconsDir)) {
        for (const f of fs.readdirSync(iconsDir)) {
          staticUrls.push(`${b}icons/${f}`);
        }
      }

      const assetsDir = path.join(distDir, 'assets');
      const assetUrls: string[] = [];
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) {
          if (f.endsWith('.js') || f.endsWith('.css')) {
            assetUrls.push(`${b}assets/${f}`);
          }
        }
      }

      const allUrls  = [...staticUrls, ...assetUrls];
      const urlsJson = JSON.stringify(allUrls, null, 2).split('\n').join('\n  ');

      let sw = fs.readFileSync(swPath, 'utf-8');
      sw = sw.replace(
        'self.__PRECACHE_URLS__ || []',
        `// ${allUrls.length} URLs — injected by injectSwPrecache (base: ${b})\n  ${urlsJson}`
      );
      fs.writeFileSync(swPath, sw, 'utf-8');

      console.log(`\n[sw] base=${b}  precaching ${allUrls.length} URLs`);
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [suppressRhwpWasmAsset(), injectSwPrecache()],
  build: {
    target: 'es2020',
    cssMinify: true,
    // rhwp 청크는 57 kB (gzip 8.6 kB) — 기본 500 kB 경고 기준 이하
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // @rhwp/core를 별도 청크로 분리 — 첫 방문 이후 브라우저 캐시 활용
        manualChunks: { rhwp: ['@rhwp/core'] },
      },
    },
  },
  optimizeDeps: {
    // @rhwp/core는 ESM + WASM 패키지이므로 pre-bundling 제외
    exclude: ['@rhwp/core'],
  },
  server: {
    headers: {
      // SharedArrayBuffer 사용 시 필요 (WASM 멀티스레드)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
