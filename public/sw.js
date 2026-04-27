// rhwp-viewer Service Worker — Cache First strategy, no Workbox
// 빌드 시 vite.config.ts의 injectSwPrecache 플러그인이
// PRECACHE_URLS 배열을 실제 hashed asset 경로로 교체함.
// 개발 서버에서는 빈 배열로 동작(네트워크 우선 폴백).

const CACHE_NAME = 'rhwp-viewer-v2';

/**
 * Share Target 내부 엔드포인트 경로.
 * SW(handleShareTarget, handleSharePending)와 메인 스레드(file-handler.ts의
 * fetch('/_share-pending')) 양쪽에서 이 경로를 사용해야 한다.
 * GitHub Pages 배포 시 base가 변경되면 이 상수 한 곳만 수정할 것.
 * 주의: file-handler.ts의 fetch 경로도 반드시 동일하게 유지해야 함.
 */
const SHARE_PENDING_PATH = '/_share-pending';

/** @type {string[]} — 빌드 플러그인이 교체하는 자리표시자 */
const PRECACHE_URLS = self.__PRECACHE_URLS__ || [];

// ── Install: 앱 셸 프리캐시 ───────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // 구 SW가 있어도 즉시 활성화. 사용자 확인 후 reload는 main.ts에서 제어.
      .then(() => self.skipWaiting())
  );
});

// ── Activate: 구 캐시 정리 + 모든 탭 즉시 제어 ────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== 'rhwp-share')
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Share Target: POST /share ─────────────────────────────────
  // manifest.json share_target.action과 일치.
  // 브라우저가 파일 공유 시 multipart/form-data로 POST 전송.
  // 지원: Android Chrome (PWA 설치 후)
  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // ── Share Pending: GET /_share-pending ─────────────────────────
  // Share Target에서 저장한 파일을 메인 스레드가 가져가는 내부 엔드포인트.
  if (request.method === 'GET' && url.pathname === SHARE_PENDING_PATH) {
    event.respondWith(handleSharePending());
    return;
  }

  // POST, chrome-extension 등 캐시 불가 요청은 네트워크에 직접 위임
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  event.respondWith(handleFetch(request));
});

// ── Share Target 처리 ─────────────────────────────────────────────

/**
 * Share Target 파일 검증.
 * manifest.json의 accept 목록과 동기화: .hwp / .hwpx 만 허용.
 * 악성 앱이 공유 인텐트로 다른 MIME/확장자 파일을 밀어 넣는 것을 차단.
 */
function isAllowedShareFile(file) {
  if (!(file instanceof File)) return false;
  if (file.size === 0 || file.size > 50 * 1024 * 1024) return false;

  const name = file.name ?? '';
  const ext  = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext !== '.hwp' && ext !== '.hwpx') return false;

  // MIME 유형 검증 (Android는 대부분 올바른 MIME을 보냄)
  // 빈 MIME은 허용 (일부 기기는 미설정), 명백히 잘못된 MIME은 차단
  const mime = (file.type ?? '').toLowerCase();
  const allowedMime = [
    '', 'application/x-hwp', 'application/haansofthwp',
    'application/hwp+zip', 'application/octet-stream',
  ];
  if (mime && !allowedMime.includes(mime)) return false;

  return true;
}

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    // manifest.json share_target.params.files[0].name = "file"
    const file = formData.get('file');

    if (!isAllowedShareFile(file)) {
      // 검증 실패 — 캐시에 저장하지 않고 리다이렉트 (share=1 제외 → 오류 없이 홈 표시)
      console.warn('[SW] Share target: 허용되지 않은 파일이 거부되었습니다.');
      return Response.redirect('/', 303);
    }

    const buffer = await file.arrayBuffer();

    // 매직 바이트 검증: OLE2 (HWP) = D0 CF 11 E0 / ZIP (HWPX) = 50 4B 03 04
    const header = new Uint8Array(buffer.slice(0, 4));
    const isOle2 = header[0] === 0xd0 && header[1] === 0xcf && header[2] === 0x11 && header[3] === 0xe0;
    const isZip  = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
    if (!isOle2 && !isZip) {
      console.warn('[SW] Share target: 매직 바이트 검증 실패 — 파일이 거부되었습니다.');
      return Response.redirect('/', 303);
    }

    const cache  = await caches.open('rhwp-share');
    await cache.put(
      new Request(SHARE_PENDING_PATH),
      new Response(buffer, {
        headers: {
          'content-type': 'application/octet-stream',
          // 파일명은 헤더로 전달 (File 객체 직접 전송 불가)
          // encodeURIComponent로 인코딩하여 헤더 인젝션 방지
          'x-filename': encodeURIComponent(
            file.name.replace(/[\r\n]/g, '')   // CRLF 인젝션 방지
          ),
          'x-content-type-options': 'nosniff',
        },
      })
    );
  } catch (e) {
    console.error('[SW] Share target 처리 오류:', e);
    return Response.redirect('/', 303);
  }

  // 메인 페이지로 리다이렉트, share=1로 메인 스레드에 신호
  return Response.redirect('/?share=1', 303);
}

async function handleSharePending() {
  const cache    = await caches.open('rhwp-share');
  const response = await cache.match(SHARE_PENDING_PATH);
  if (!response) return new Response(null, { status: 404 });

  // 1회 소비: 가져간 즉시 삭제해 재사용 방지
  await cache.delete(SHARE_PENDING_PATH);
  return response;
}

// ── Cache First 전략 ──────────────────────────────────────────────

async function handleFetch(request) {
  // 1. 캐시 히트 → 즉시 반환
  const cached = await caches.match(request);
  if (cached) return cached;

  // 2. 캐시 미스 → 네트워크
  try {
    const response = await fetch(request);

    // 캐시 저장 조건:
    //   response.ok    : 2xx 상태 코드
    //   response.type === 'basic' : 동일 출처 응답만 (opaque 차단)
    //   URL이 프리캐시 목록에 있는 경우: 선점 캐시된 것이므로 동적 재캐시 불필요
    // opaque 응답(type='opaque')은 상태 코드를 알 수 없어 오류 응답을 캐시할 위험이 있음.
    if (
      response.ok &&
      response.type === 'basic' &&
      request.url.startsWith(self.location.origin)
    ) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // 3. 네트워크 실패 → 오프라인 폴백
    // HTML navigation: 앱 셸(/)로 폴백해 오프라인에서도 앱 진입 가능
    if (
      request.mode === 'navigate' ||
      request.headers.get('accept')?.includes('text/html')
    ) {
      const shell = await caches.match('/');
      if (shell) return shell;
    }

    return new Response('Service Unavailable', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ── Message: main.ts에서 업데이트 요청 수신 ──────────────────────
self.addEventListener('message', (event) => {
  // 발신 출처 검증: 동일 출처 클라이언트에서만 skipWaiting 허용.
  // event.origin이 빈 문자열인 경우(null origin)도 거부.
  if (event.origin && event.origin !== self.location.origin) return;

  // 사용자가 업데이트 확인 시 main.ts가 'skipWaiting' 전송
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
