import './styles/main.css';
import { RhwpViewer, type ViewMode } from './viewer';
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

/** progress를 start→end까지 durationMs 동안 서서히 증가시킨다. 반환값로 취소 가능. */
function animateProgress(start: number, end: number, durationMs: number): () => void {
  const STEPS = 40;
  const stepMs = durationMs / STEPS;
  const delta = (end - start) / STEPS;
  let current = start;
  const id = setInterval(() => {
    current += delta;
    if (current >= end) { clearInterval(id); return; }
    ui.setLoadingProgress(Math.round(current));
  }, stepMs);
  return () => clearInterval(id);
}

const ui = new UIController();

// onPageChange 콜백으로 페이지 UI 동기화 (prevPage/nextPage가 async이므로)
const viewer = new RhwpViewer(
  getEl('viewer-container'),
  (current, total) => {
    ui.updatePageInfo(current, total);
    // 페이지 전환 시 SVG가 교체되므로 하이라이트 레이어 참조와 이전 결과를 초기화하고 재검색
    searchHighlightLayer = null;
    searchMatches = [];
    searchCurrentIdx = -1;
    if (searchQuery.trim()) runSearch(searchQuery);
  }
);

const storage = new RecentFileStorage();

const fileHandler = new FileHandler(
  // onFileOpen: 파일 검증 통과 후 호출
  async (file, buffer) => {
    ui.showLoading('WASM 엔진 초기화 중...', 15);
    try {
      if (!viewer.isInitialized()) {
        // WASM 다운로드·컴파일은 수 초가 걸릴 수 있으므로 진행 바를 서서히 증가
        const cancelAnim = animateProgress(15, 45, 6000);
        await viewer.init();
        cancelAnim();
      }
      ui.showLoading('문서를 분석하는 중...', 50);
      await viewer.loadFile(buffer);
      ui.showLoading('페이지를 그리는 중...', 80);
      ui.showViewer(file.name);
      maybeShowTapHint();
      // 초기 로드는 로딩 오버레이가 덮고 있으므로 애니메이션 불필요
      await viewer.renderPage(0, false);
      void storage.addRecentFile({ name: file.name, size: file.size });
    } catch (err) {
      // 프로덕션 빌드에서는 스택 트레이스를 사용자에게 노출하지 않음 (VULN-011)
      const detail = (import.meta.env.DEV && err instanceof Error)
        ? (err.stack ?? err.message)
        : undefined;

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

// ── 검색 상태 ──────────────────────────────────────────
let searchQuery       = '';
let searchMatches: SVGGraphicsElement[] = [];
let searchCurrentIdx  = -1;
let searchHighlightLayer: SVGGElement | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function openSearch(): void {
  hideTapMenu();
  getEl('search-bar').hidden = false;
  getEl('viewer-screen').classList.add('search-open');
  const input = getEl('search-input') as HTMLInputElement;
  input.focus();
  input.select();
}

function closeSearch(): void {
  if (searchDebounceTimer !== null) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  getEl('search-bar').hidden = true;
  getEl('viewer-screen').classList.remove('search-open');
  clearSearchHighlights();
  (getEl('search-input') as HTMLInputElement).value = '';
  searchQuery = '';
  searchMatches = [];
  searchCurrentIdx = -1;
  (getEl('search-count') as HTMLSpanElement).textContent = '';
  (getEl('search-prev-btn') as HTMLButtonElement).disabled = true;
  (getEl('search-next-btn') as HTMLButtonElement).disabled = true;
}

function clearSearchHighlights(): void {
  if (searchHighlightLayer?.isConnected) searchHighlightLayer.remove();
  searchHighlightLayer = null;
}

function runSearch(query: string): void {
  clearSearchHighlights();
  searchQuery = query;
  searchMatches = [];
  searchCurrentIdx = -1;

  const countEl  = getEl('search-count')    as HTMLSpanElement;
  const prevBtn  = getEl('search-prev-btn') as HTMLButtonElement;
  const nextBtn  = getEl('search-next-btn') as HTMLButtonElement;

  if (!query.trim()) {
    countEl.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const svgEl = viewerContainer.querySelector<SVGSVGElement>('svg');
  if (!svgEl) {
    countEl.textContent = '이 페이지에 없음';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const lowerQuery = query.toLowerCase();
  const matches: SVGGraphicsElement[] = [];

  // tspan 리프(직접 텍스트 노드 포함) 우선 매칭 — 더 정밀한 하이라이트 영역
  for (const el of svgEl.querySelectorAll<SVGGraphicsElement>('tspan')) {
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent ?? '')
      .join('');
    if (directText.toLowerCase().includes(lowerQuery)) matches.push(el);
  }

  // tspan 결과 없으면 text 요소 전체 textContent로 재시도 (tspan 경계를 넘는 검색어 포함)
  if (matches.length === 0) {
    for (const el of svgEl.querySelectorAll<SVGGraphicsElement>('text')) {
      if ((el.textContent ?? '').toLowerCase().includes(lowerQuery)) matches.push(el);
    }
  }

  searchMatches = matches;

  if (matches.length === 0) {
    countEl.textContent = '이 페이지에 없음';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  // SVG 내 하이라이트 레이어 — defs/style/symbol 등 비렌더링 노드 뒤, 첫 렌더링 요소 앞에 삽입
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute('pointer-events', 'none');
  const NON_RENDERED = new Set(['defs','style','symbol','clipPath','mask','filter','marker','linearGradient','radialGradient','pattern']);
  let refNode: ChildNode | null = svgEl.firstChild;
  while (refNode && refNode.nodeType === Node.ELEMENT_NODE
         && NON_RENDERED.has((refNode as Element).tagName.toLowerCase())) {
    refNode = refNode.nextSibling;
  }
  svgEl.insertBefore(layer, refNode);
  searchHighlightLayer = layer;

  for (let i = 0; i < matches.length; i++) {
    try {
      const box = matches[i].getBBox();
      if (box.width === 0 && box.height === 0) continue;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(box.x - 2));
      rect.setAttribute('y', String(box.y - 1));
      rect.setAttribute('width',  String(box.width + 4));
      rect.setAttribute('height', String(box.height + 2));
      rect.setAttribute('rx', '2');
      rect.setAttribute('data-match-idx', String(i));
      layer.appendChild(rect);
    } catch { /* getBBox 실패 시 해당 항목 건너뜀 */ }
  }

  searchCurrentIdx = 0;
  updateSearchUI();
  scrollToSearchMatch(0);
}

function updateSearchUI(): void {
  const countEl = getEl('search-count')    as HTMLSpanElement;
  const prevBtn = getEl('search-prev-btn') as HTMLButtonElement;
  const nextBtn = getEl('search-next-btn') as HTMLButtonElement;

  if (searchMatches.length === 0) return;

  countEl.textContent = `${searchCurrentIdx + 1} / ${searchMatches.length}`;
  prevBtn.disabled = searchMatches.length <= 1;
  nextBtn.disabled = searchMatches.length <= 1;

  if (searchHighlightLayer) {
    searchHighlightLayer.querySelectorAll('rect').forEach((rect, i) => {
      rect.setAttribute('fill',
        i === searchCurrentIdx
          ? 'rgba(255, 140, 0, 0.55)'
          : 'rgba(255, 220, 0, 0.35)',
      );
    });
  }
}

function scrollToSearchMatch(idx: number): void {
  if (idx < 0 || idx >= searchMatches.length) return;
  const el = searchMatches[idx];
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  } catch { /* 미지원 브라우저 폴백 */ }

  const svgEl = viewerContainer.querySelector<SVGSVGElement>('svg');
  if (!svgEl) return;
  try {
    const box     = el.getBBox();
    const svgRect = svgEl.getBoundingClientRect();
    const vb      = svgEl.viewBox?.baseVal;
    if (!vb || vb.width === 0) return;
    const scaleY       = svgRect.height / vb.height;
    const elemScreenCY = svgRect.top + (box.y + box.height / 2) * scaleY;
    const containerCY  = viewerContainer.getBoundingClientRect().top + viewerContainer.clientHeight / 2;
    viewerContainer.scrollBy({ top: elemScreenCY - containerCY, behavior: 'smooth' });
  } catch { /* ignore */ }
}

// ── 텍스트 선택 모드 ──────────────────────────────────
let textSelectMode = false;

function enterTextSelectMode(): void {
  hideTapMenu();
  textSelectMode = true;
  getEl('viewer-screen').classList.add('text-select-mode');
  getEl('text-select-bar').hidden = false;
  touch.detach();
}

function exitTextSelectMode(): void {
  textSelectMode = false;
  getEl('viewer-screen').classList.remove('text-select-mode');
  getEl('text-select-bar').hidden = true;
  touch.attach();
  try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
}

// ── 탭 존 미니 메뉴 ──────────────────────────────────
const tapMenu = getEl('tap-menu');

function showTapMenu(): void {
  tapMenu.hidden = false;
}

function hideTapMenu(): void {
  tapMenu.hidden = true;
}

getEl('tap-menu-new-file').addEventListener('click', () => {
  hideTapMenu();
  ui.showHome();
});

getEl('tap-menu-page-jump').addEventListener('click', () => {
  hideTapMenu();
  const total = viewer.getPageCount();
  if (total > 0) showPageJumpSheet(total, (page) => viewer.goToPage(page - 1));
});

getEl('tap-menu-close').addEventListener('click', hideTapMenu);

getEl('tap-menu-find').addEventListener('click', () => {
  openSearch();
});

getEl('tap-menu-text-select').addEventListener('click', () => {
  enterTextSelectMode();
});

// ── 검색 바 이벤트 ──────────────────────────────────────
getEl('search-input').addEventListener('input', (e) => {
  const query = (e.target as HTMLInputElement).value;
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    runSearch(query);
  }, 200);
});

getEl('search-input').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'ArrowDown') {
    e.preventDefault();
    if (searchMatches.length === 0) return;
    searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
    updateSearchUI();
    scrollToSearchMatch(searchCurrentIdx);
  } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
    e.preventDefault();
    if (searchMatches.length === 0) return;
    searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
    updateSearchUI();
    scrollToSearchMatch(searchCurrentIdx);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

// type="search" 의 기본 클리어(×) 버튼은 input 이벤트를 발화시키므로 별도 처리 불필요

getEl('search-prev-btn').addEventListener('click', () => {
  if (searchMatches.length === 0) return;
  searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
  updateSearchUI();
  scrollToSearchMatch(searchCurrentIdx);
});

getEl('search-next-btn').addEventListener('click', () => {
  if (searchMatches.length === 0) return;
  searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
  updateSearchUI();
  scrollToSearchMatch(searchCurrentIdx);
});

getEl('search-close-btn').addEventListener('click', closeSearch);

// ── 텍스트 선택 모드 ─────────────────────────────────────
getEl('text-select-done-btn').addEventListener('click', exitTextSelectMode);

// 메뉴 외부 탭 → 닫기
tapMenu.addEventListener('click', (e) => {
  if (e.target === tapMenu) hideTapMenu();
});

// ── 화면 보기 모드 ────────────────────────────────────────

const VIEW_MODE_IDS: Record<string, ViewMode> = {
  'tap-menu-fit-page':   'fit-page',
  'tap-menu-fit-width':  'fit-width',
  'tap-menu-fit-height': 'fit-height',
};

function updateViewModeButtons(active: ViewMode): void {
  for (const [id, mode] of Object.entries(VIEW_MODE_IDS)) {
    getEl(id).setAttribute('aria-pressed', String(mode === active));
  }
}

for (const [id, mode] of Object.entries(VIEW_MODE_IDS)) {
  getEl(id).addEventListener('click', () => {
    hideTapMenu();
    viewer.setViewMode(mode);
    updateViewModeButtons(mode);
  });
}

// ── 탭 존 힌트 ───────────────────────────────────────
const TAP_HINT_KEY = 'rhwp-tap-hint-shown';

function maybeShowTapHint(): void {
  if (localStorage.getItem(TAP_HINT_KEY)) return;
  getEl('tap-hint').hidden = false;
}

getEl('tap-hint-dismiss').addEventListener('click', () => {
  getEl('tap-hint').hidden = true;
  localStorage.setItem(TAP_HINT_KEY, '1');
});

// ── 터치 제스처 (모바일) ──────────────────────────────
const viewerContainer = getEl('viewer-container');

const DOUBLE_TAP_ZOOM = 2.5;

const touch = new TouchHandler(viewerContainer, {
  onSwipeLeft:   () => viewer.nextPage(),
  onSwipeRight:  () => viewer.prevPage(),
  onTap:         (x) => handleTapZone(x),
  onDoubleTap:   (x, y) => {
    const next = viewer.getZoom() > 1.0 ? 1.0 : DOUBLE_TAP_ZOOM;
    viewer.setZoomAnimated(next, x, y);
  },
  onPinchChange: (scale, cx, cy) => viewer.setZoom(scale, cx, cy),
  onPinchEnd:    (scale, cx, cy) => viewer.setZoom(scale, cx, cy),
  onPan:         (dx, dy) => viewer.pan(dx, dy),
  onScroll:      (dy)       => viewer.scrollBy(dy),
});

touch.setBoundaryCheckers(
  () => viewer.getCurrentPage() > 0,
  () => viewer.getCurrentPage() < viewer.getPageCount() - 1,
);
touch.setTransitionChecker(() => viewer.isTransitioning());

touch.attach();

function handleTapZone(clientX: number): void {
  if (!tapMenu.hidden) { hideTapMenu(); return; }
  const w = window.innerWidth;

  // 가로 채움 모드(fit-width)에서 줌이 1배일 때:
  // 좌탭 = 상단으로 (상단이면 이전 페이지), 우탭 = 하단으로 (하단이면 다음 페이지)
  if (viewer.getViewMode() === 'fit-width' && viewer.getZoom() <= 1.0) {
    if (clientX < w / 3) {
      if (viewer.isAtScrollTop()) viewer.prevPage();
      else viewer.scrollToTop();
    } else if (clientX > (w * 2) / 3) {
      if (viewer.isAtScrollBottom()) viewer.nextPage();
      else viewer.scrollToBottom();
    } else {
      showTapMenu();
    }
    return;
  }

  // 기본: 좌=이전 페이지, 중=메뉴, 우=다음 페이지
  if (clientX < w / 3) {
    viewer.prevPage();
  } else if (clientX > (w * 2) / 3) {
    viewer.nextPage();
  } else {
    showTapMenu();
  }
}

// 데스크톱: 마우스 클릭도 탭 존과 동일하게 처리 (텍스트 선택 모드 제외)
viewerContainer.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (textSelectMode) return;
  handleTapZone(e.clientX);
});

viewer.setOnZoomChange(s => touch.setCurrentScale(s));
viewer.setOnViewModeChange(() => { if (searchQuery.trim()) runSearch(searchQuery); });


// 키보드 탐색 (데스크톱)
document.addEventListener('keydown', (e) => {
  if (getEl('viewer-screen').hidden) return;

  // Ctrl/Cmd+F: 검색 열기 (입력 중에도 동작)
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }

  // Escape: 검색 바가 열려 있으면 닫기
  if (e.key === 'Escape' && !getEl('search-bar').hidden) {
    closeSearch();
    return;
  }

  // 입력 중에는 페이지 탐색 키 무시
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
  // JS 로드 전 표시된 인라인 스피너 제거
  document.getElementById('app-loading')?.remove();

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
    import.meta.env.DEV && err instanceof Error ? err.stack : undefined,
  );
});

// ── 페이지 이동 바텀시트 ──────────────────────────────
// prompt() 대체 — 비차단, 모바일 키보드 친화적, 접근성 기준 충족

function showPageJumpSheet(total: number, onGo: (page: number) => void): void {
  // 중복 호출 방지 — Samsung Internet 등에서 이벤트 버블링으로 재호출될 수 있음
  if (document.querySelector('.page-jump-backdrop')) return;

  const safeTotal = Math.max(0, Math.floor(total));

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

  const close = () => {
    backdrop.style.opacity = '0';
    backdrop.style.pointerEvents = 'none';
    setTimeout(() => backdrop.remove(), 150);
  };

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
  // sheet 내부 탭이 backdrop click으로 버블링되지 않도록 차단
  sheet.addEventListener('click', (e) => e.stopPropagation());
  // backdrop 바깥 탭 → 닫기
  backdrop.addEventListener('click', close);
  // Enter 키 → 이동
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') close();
  });

  document.body.appendChild(backdrop);
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
