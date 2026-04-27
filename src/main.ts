import './styles/main.css';
import { RhwpViewer } from './viewer';
import { UIController } from './ui';
import { FileHandler } from './file-handler';
import { RecentFileStorage } from './storage';
import { TouchHandler } from './touch';

// ── DOM 헬퍼: ! assertion 대신 존재 검사 후 반환 ─────────────────────
// ID가 없으면 초기화 단계에서 즉시 오류를 발생시켜 런타임 NPE를 방지.
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`DOM 요소를 찾을 수 없습니다: #${id}`);
  return el;
}

const ui = new UIController();

// onPageChange 콜백으로 페이지 UI 동기화 (prevPage/nextPage가 async이므로)
const viewer = new RhwpViewer(
  getEl('viewer-container'),
  (current, total) => {
    ui.updatePageInfo(current, total);
    ui.updateNavButtons(current, total);
  }
);

const storage = new RecentFileStorage();

const fileHandler = new FileHandler(
  // onFileOpen: 파일 검증 통과 후 호출
  async (file, buffer) => {
    ui.showLoading('WASM 엔진 초기화 중...', 15);
    try {
      if (!viewer.isInitialized()) {
        await viewer.init();
      }
      ui.showLoading('문서를 분석하는 중...', 50);
      await viewer.loadFile(buffer);
      ui.showLoading('페이지를 그리는 중...', 80);
      ui.showViewer(file.name);
      // 초기 로드는 로딩 오버레이가 덮고 있으므로 애니메이션 불필요
      await viewer.renderPage(0, false);
      void storage.addRecentFile({ name: file.name, size: file.size });
    } catch (err) {
      const detail = err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);

      // WASM 초기화 실패 여부로 오류 메시지 분기
      if (!viewer.isInitialized()) {
        ui.showError(
          'WebAssembly를 초기화할 수 없습니다. 브라우저를 최신 버전으로 업데이트하거나 Chrome, Edge, Safari를 사용해 주세요.',
          () => ui.showHome(),
          detail,
        );
      } else {
        const message = err instanceof Error ? err.message : '파일을 열 수 없습니다.';
        ui.showError(message, () => ui.showHome(), detail);
      }
    } finally {
      ui.hideLoading();
    }
  },
  // onError: 파일 검증 실패 시 호출 (확장자·매직바이트·크기 등)
  (err) => {
    ui.showError(err.message, () => ui.showHome());
  }
);

// ── 이벤트 바인딩 ────────────────────────────────

getEl('open-file-btn').addEventListener('click', () => {
  fileHandler.openFilePicker();
});

// stopPropagation: toolbar/page-nav 클릭이 viewer-container까지 전파되지 않도록
getEl('back-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  ui.showHome();
});

getEl('prev-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  viewer.prevPage();
});

getEl('next-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  viewer.nextPage();
});

// ── 터치 제스처 (모바일) ──────────────────────────────
const viewerContainer = getEl('viewer-container');

const DOUBLE_TAP_ZOOM = 2.5;

const touch = new TouchHandler(viewerContainer, {
  onSwipeLeft:   () => viewer.nextPage(),
  onSwipeRight:  () => viewer.prevPage(),
  onTap:         () => ui.toggleImmersive(),
  onDoubleTap:   (x, y) => {
    const next = viewer.getZoom() > 1.0 ? 1.0 : DOUBLE_TAP_ZOOM;
    viewer.setZoomAnimated(next, x, y);
  },
  onPinchChange: (scale, cx, cy) => viewer.setZoom(scale, cx, cy),
  onPinchEnd:    (scale, cx, cy) => viewer.setZoom(scale, cx, cy),
  onPan:         (dx, dy) => viewer.pan(dx, dy),
});

touch.setBoundaryCheckers(
  () => viewer.getCurrentPage() > 0,
  () => viewer.getCurrentPage() < viewer.getPageCount() - 1,
);
touch.setTransitionChecker(() => viewer.isTransitioning());

touch.attach();

// 데스크톱: 마우스 클릭을 탭과 동일하게 처리 (몰입 모드 토글)
// pointerType === 'mouse' 로 터치 이벤트와 구분해 중복 실행 방지
viewerContainer.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse') return;
  ui.toggleImmersive();
});

viewer.setOnZoomChange(s => touch.setCurrentScale(s));

// 페이지 번호 탭 → 직접 이동 — prompt() 대신 바텀시트 모달 사용
// prompt()는 메인 스레드를 블로킹하고 모바일에서 키보드 제어가 불가
getEl('page-info').addEventListener('click', (e) => {
  e.stopPropagation();
  const total = viewer.getPageCount();
  if (total === 0) return;
  showPageJumpSheet(total, (page) => viewer.goToPage(page - 1));
});

// 키보드 탐색 (데스크톱)
document.addEventListener('keydown', (e) => {
  if (getEl('viewer-screen').hidden) return;
  // 입력 중에는 무시
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': viewer.nextPage(); break;
    case 'ArrowLeft':  case 'PageUp':   viewer.prevPage(); break;
    case 'Home': viewer.goToPage(0); break;
    case 'End':  viewer.goToPage(viewer.getPageCount() - 1); break;
  }
});

// ── PWA 설치 배너 ─────────────────────────────────

let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  if (!localStorage.getItem('install-dismissed')) {
    getEl('install-banner').hidden = false;
  }
});

getEl('install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  getEl('install-banner').hidden = true;
});

getEl('install-dismiss-btn').addEventListener('click', () => {
  localStorage.setItem('install-dismissed', '1');
  getEl('install-banner').hidden = true;
});

// ── Service Worker ────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // BASE_URL은 Vite가 빌드 시 주입 (dev: '/', GitHub Pages: '/rhwp-viewer/')
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          if (!next) return;

          next.addEventListener('statechange', () => {
            // 'installed' + 기존 controller 존재 = 새 버전 대기 중
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              // window.confirm() 제거 — 메인 스레드 블로킹 + 모바일에서 UX 저해
              // 비차단 토스트로 교체: 사용자가 원할 때 새로고침 선택 가능
              showUpdateToast(() => next.postMessage('skipWaiting'));
            }
          });
        });
      })
      .catch(() => {
        // SW 미등록은 앱 동작에 영향 없음 (오프라인 기능만 비활성화)
      });

    // SW가 교체되면(controllerchange) 페이지 새로고침
    // isReloading 플래그: 새로고침 후 SW가 다시 교체되는 경우의 무한 루프 방지
    let isReloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (isReloading) return;
      isReloading = true;
      window.location.reload();
    });
  });
}

// ── 오프라인 감지 ─────────────────────────────────
// PWA 캐시가 있으면 오프라인에서도 뷰어는 동작하지만, 외부 URL 로드 등은 실패할 수 있음.
// 상태 변화 시 토스트 배너로 알림.

function syncOnlineStatus() {
  if (navigator.onLine) {
    ui.hideOfflineBanner();
  } else {
    ui.showOfflineBanner();
  }
}

window.addEventListener('online',  syncOnlineStatus);
window.addEventListener('offline', syncOnlineStatus);

// ── 초기 실행 ─────────────────────────────────────

async function bootstrap() {
  await storage.init();
  fileHandler.attachInputHandler();
  // home-screen 전체에서 드래그 수신, drop-zone만 하이라이트
  fileHandler.attachDropZone(
    getEl('home-screen'),
    getEl('drop-zone'),
  );
  fileHandler.attachFileHandlingAPI();
  fileHandler.attachUrlParam();
  void fileHandler.attachShareTarget(); // showHome() 이후 비동기 처리
  ui.showHome();
}

bootstrap().catch((err) => {
  ui.showError(
    `앱 초기화 실패: ${err instanceof Error ? err.message : String(err)}`,
    undefined,
    err instanceof Error ? err.stack : undefined,
  );
});

// ── 페이지 이동 바텀시트 ──────────────────────────────
// prompt() 대체 — 비차단, 모바일 키보드 친화적, 접근성 기준 충족

function showPageJumpSheet(total: number, onGo: (page: number) => void): void {
  // total은 WASM pageCount()에서 오는 정수이지만, innerHTML에 직접 보간하지 않고
  // DOM API로 속성/텍스트를 설정해 모든 XSS 경로를 원천 차단한다.
  const safeTotal = Math.max(0, Math.floor(total)); // 방어적 정수화

  const backdrop = document.createElement('div');
  backdrop.className = 'page-jump-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', `페이지 이동 (1 ~ ${safeTotal})`);

  // innerHTML 대신 DOM API로 구성
  const sheet       = document.createElement('div');
  sheet.className   = 'page-jump-sheet';

  const label       = document.createElement('span');
  label.className   = 'page-jump-label';
  label.textContent = `페이지 이동 (1 ~ ${safeTotal})`;

  const input         = document.createElement('input');
  input.className     = 'page-jump-input';
  input.type          = 'number';
  input.setAttribute('inputmode', 'numeric');
  input.min           = '1';
  input.max           = String(safeTotal);
  input.placeholder   = String(safeTotal > 0 ? Math.ceil(safeTotal / 2) : 1);
  input.setAttribute('aria-label', '이동할 페이지 번호');

  const actions     = document.createElement('div');
  actions.className = 'page-jump-actions';

  const cancelBtn     = document.createElement('button');
  cancelBtn.className = 'page-jump-cancel';
  cancelBtn.type      = 'button';
  cancelBtn.textContent = '취소';

  const goBtn     = document.createElement('button');
  goBtn.className = 'page-jump-go';
  goBtn.type      = 'button';
  goBtn.textContent = '이동';

  actions.appendChild(cancelBtn);
  actions.appendChild(goBtn);
  sheet.appendChild(label);
  sheet.appendChild(input);
  sheet.appendChild(actions);
  backdrop.appendChild(sheet);

  const commit = () => {
    const n = parseInt(input.value, 10);
    if (!isNaN(n) && n >= 1 && n <= safeTotal) {
      close();
      onGo(n);
    } else {
      input.focus();
      input.select();
    }
  };

  goBtn.addEventListener('click', commit);
  cancelBtn.addEventListener('click', close);
  // backdrop 바깥 탭 → 닫기
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  // Enter 키 → 이동
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') close();
  });

  document.body.appendChild(backdrop);
  // 다음 프레임에 포커스 — 키보드 자동 표시
  requestAnimationFrame(() => input.focus());
}

// ── SW 업데이트 토스트 ────────────────────────────────
// window.confirm() 대체 — 비차단(non-blocking), 사용자가 원할 때 새로고침 선택

function showUpdateToast(onRefresh: () => void): void {
  const toast = getEl('update-toast');
  toast.hidden = false;

  getEl('update-refresh-btn').addEventListener('click', () => {
    toast.hidden = true;
    onRefresh();
  }, { once: true });

  getEl('update-dismiss-btn').addEventListener('click', () => {
    toast.hidden = true;
  }, { once: true });
}

// BeforeInstallPromptEvent 타입 (표준 미포함)
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
