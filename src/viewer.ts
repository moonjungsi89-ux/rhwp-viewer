import type { HwpViewer as HwpViewerType } from '@rhwp/core';

export type PageChangeCallback = (current: number, total: number) => void;
export type ZoomChangeCallback = (scale: number) => void;

// ── SVG 새니타이저 ──────────────────────────────────────────────────
//
// @rhwp/core의 renderPageSvg()는 신뢰되지 않는 HWP 파일로부터 SVG 문자열을
// 생성한다. 악성 HWP 파일이 SVG 안에 <script>, on* 이벤트 핸들러, href="javascript:"
// 등의 실행 가능한 코드를 포함할 수 있으므로, innerHTML 삽입 전 반드시 제거해야 한다.
//
// 전략: DOMParser로 SVG를 파싱한 후 DOM을 순회해 위험 노드/속성을 제거.
//   - ELEMENT 노드: 허용 목록(ALLOWED_TAGS)에 없으면 요소 전체를 제거.
//   - 속성: 허용 목록(ALLOWED_ATTRS)에 없거나, href/xlink:href 값이
//     javascript: 또는 data: 스킴이면 제거.
//   - 텍스트/CDATASection 노드: 유지 (SVG 텍스트 콘텐츠).
//   - ProcessingInstruction / Comment 노드: 제거.
//   sanitize()는 항상 string을 반환하며, 파싱 실패 시 빈 문자열을 반환한다.

const ALLOWED_SVG_TAGS = new Set([
  'svg','g','defs','symbol','use',
  'rect','circle','ellipse','line','polyline','polygon','path',
  'text','tspan','textpath','tref',
  'image',
  'linearGradient','radialGradient','stop','pattern','clipPath','mask',
  'marker','filter','feDiffuseLighting','feFlood','feComposite',
  'feGaussianBlur','feOffset','feBlend','feColorMatrix','feMerge',
  'feMergeNode','feTurbulence','feDisplacementMap',
  'title','desc',    // accessibility — text only, no script vectors
  'metadata',        // kept but children sanitized
]);

const ALLOWED_SVG_ATTRS = new Set([
  // presentation / geometry
  'id','class','style',
  'x','y','x1','y1','x2','y2','cx','cy','r','rx','ry',
  'width','height','d','points','transform','viewBox','preserveAspectRatio',
  'fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity',
  'stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset',
  'opacity','display','visibility','overflow','clip-path','clip-rule',
  'mask','filter',
  // gradient / stop
  'gradientUnits','gradientTransform','spreadMethod','offset','stop-color','stop-opacity',
  // text
  'font-family','font-size','font-weight','font-style','font-variant',
  'text-anchor','alignment-baseline','dominant-baseline','writing-mode',
  'letter-spacing','word-spacing','text-decoration','dx','dy',
  // linking / reuse (href values are filtered separately below)
  'href','xlink:href',
  // clip/mask/filter references
  'clip-path','clipPathUnits','maskUnits','maskContentUnits',
  'patternUnits','patternTransform','patternContentUnits',
  'filterUnits','primitiveUnits','in','in2','result','mode','type',
  'baseFrequency','numOctaves','seed','scale','xChannelSelector','yChannelSelector',
  'stdDeviation','k1','k2','k3','k4','operator','values',
  'markerWidth','markerHeight','refX','refY','orient','markerUnits',
  // color
  'color','color-interpolation','color-interpolation-filters','color-rendering',
  // misc
  'shape-rendering','image-rendering','text-rendering','vector-effect',
  'data-*',   // data attributes are inert
  'aria-label','aria-hidden','role',
  // namespace
  'xmlns','xmlns:xlink',
]);

/** javascript: / data: / vbscript: 스킴 차단 */
function isDangerousUrl(value: string): boolean {
  const lower = value.trim().toLowerCase().replace(/[\u0000-\u001f\u007f]+/g, '');
  return lower.startsWith('javascript:')
      || lower.startsWith('vbscript:')
      || lower.startsWith('data:text')
      || lower.startsWith('data:application');
}

/**
 * DOM 노드를 재귀적으로 새니타이즈.
 * 허용되지 않는 요소/속성을 제자리에서(in-place) 제거한다.
 */
function sanitizeNode(node: Node): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    switch (child.nodeType) {
      case Node.ELEMENT_NODE: {
        const el   = child as Element;
        const tag  = el.tagName.toLowerCase();
        if (!ALLOWED_SVG_TAGS.has(tag)) {
          node.removeChild(child);
          break;
        }
        // 속성 필터링
        const attrNames = Array.from(el.attributes).map(a => a.name);
        for (const name of attrNames) {
          const lower = name.toLowerCase();
          // 이벤트 핸들러 (on*)
          if (lower.startsWith('on')) { el.removeAttribute(name); continue; }
          // data-* 속성은 허용
          if (lower.startsWith('data-')) continue;
          // aria-* 속성은 허용
          if (lower.startsWith('aria-')) continue;
          if (!ALLOWED_SVG_ATTRS.has(lower)) {
            el.removeAttribute(name);
            continue;
          }
          // href / xlink:href 값이 위험하면 제거
          if (lower === 'href' || lower === 'xlink:href') {
            const val = el.getAttribute(name) ?? '';
            if (isDangerousUrl(val)) el.removeAttribute(name);
          }
        }
        // style 속성 내 expression() / url(javascript:) 제거
        if (el.hasAttribute('style')) {
          const safe = (el.getAttribute('style') ?? '')
            .replace(/expression\s*\(/gi, '')
            .replace(/javascript\s*:/gi, '')
            .replace(/vbscript\s*:/gi, '');
          el.setAttribute('style', safe);
        }
        sanitizeNode(child);
        break;
      }
      case Node.COMMENT_NODE:
      case Node.PROCESSING_INSTRUCTION_NODE:
        node.removeChild(child);
        break;
      // TEXT_NODE, CDATA_SECTION_NODE: 유지
    }
  }
}

/**
 * WASM이 반환한 SVG 문자열을 새니타이즈해 안전한 문자열로 반환.
 * 파싱 실패 또는 루트 요소가 <svg>가 아닌 경우 빈 문자열 반환.
 */
function sanitizeSvg(svgString: string): string {
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(svgString, 'image/svg+xml');

    // 파싱 오류 감지
    if (doc.querySelector('parsererror')) return '';

    const svgEl = doc.documentElement;
    if (svgEl.tagName.toLowerCase() !== 'svg') return '';

    sanitizeNode(svgEl);
    return new XMLSerializer().serializeToString(svgEl);
  } catch {
    return '';
  }
}

const FADE_DURATION_MS     = 140;
const ZOOM_IDENTITY        = 1.0; // 기본(100%) 줌 레벨 — 매직 넘버 방지
const ZOOM_MIN             = 0.5;
const ZOOM_MAX             = 3.0;
const ZOOM_ANIMATED_EASING = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
const ZOOM_ANIMATED_MS     = 300;
const SVG_CACHE_MAX        = 10; // 최대 캐시 페이지 수 (메모리 상한)

export class RhwpViewer {
  private container: HTMLElement;
  private hwpViewer: HwpViewerType | null = null;
  private pageCount    = 0;
  private currentPage  = 0;
  private scale        = 1.0;
  private translateX   = 0;
  private initialized  = false;
  private transitioning = false;

  private onPageChange: PageChangeCallback | null = null;
  private onZoomChange: ZoomChangeCallback | null = null;

  // SVG 문자열 캐시: 렌더링된 페이지를 보관해 재방문 시 WASM 호출 생략
  private svgCache = new Map<number, string>();

  constructor(container: HTMLElement, onPageChange?: PageChangeCallback) {
    this.container    = container;
    this.onPageChange = onPageChange ?? null;
  }

  setOnZoomChange(cb: ZoomChangeCallback): void {
    this.onZoomChange = cb;
  }

  // ── 초기화 ────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    // Canvas를 한 번만 생성해 재사용 — 호출마다 생성하면 GC 부담
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d')!;
    (globalThis as Record<string, unknown>).measureTextWidth = (
      font: string, text: string
    ): number => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };

    const { default: initWasm } = await import('@rhwp/core');
    // BASE_URL은 Vite가 빌드 시 주입 (dev: '/', GitHub Pages: '/rhwp-viewer/')
    await initWasm({ module_or_path: `${import.meta.env.BASE_URL}rhwp_bg.wasm` });
    this.initialized = true;
  }

  // ── 파일 로드 ─────────────────────────────────────────────

  async loadFile(buffer: ArrayBuffer): Promise<void> {
    if (!this.initialized) throw new Error('init()을 먼저 호출하세요.');

    const { HwpDocument, HwpViewer } = await import('@rhwp/core');
    const doc = new HwpDocument(new Uint8Array(buffer));
    this.hwpViewer?.free();
    this.hwpViewer = new HwpViewer(doc);

    this.pageCount    = this.hwpViewer.pageCount();
    this.currentPage  = 0;
    this.scale        = ZOOM_IDENTITY;
    this.translateX   = 0;
    this.transitioning = false;
    this.svgCache.clear(); // 새 문서 로드 시 이전 캐시 전체 폐기
    this.container.scrollTop = 0;
  }

  // ── 렌더링 ───────────────────────────────────────────────

  async renderPage(pageIndex: number, animated = true): Promise<void> {
    if (!this.hwpViewer) throw new Error('loadFile()을 먼저 호출하세요.');
    if (pageIndex < 0 || pageIndex >= this.pageCount) return;
    if (this.transitioning) return;

    this.transitioning = true;

    const hasContent = this.container.querySelector('svg') !== null;
    if (animated && hasContent) {
      this.container.classList.add('page-exit');
      await delay(FADE_DURATION_MS);
    }

    let wrapper = this.container.querySelector<HTMLElement>('.page-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      this.container.appendChild(wrapper);
    }

    // finally로 transitioning 잠금 해제 보장: DOM 조작 중 예외에서도 앱 영구 정지 방지
    let renderSucceeded = false;
    try {
      const rawSvg    = await this.getSvgString(pageIndex, wrapper);
      // rawSvg === null: WASM 렌더 실패 (오류 카드는 getSvgString 내부에서 삽입 완료)
      // sanitizeSvg() === '': SVG 파싱/새니타이즈 실패 → 동일하게 오류 카드 표시
      const svgString = rawSvg !== null ? sanitizeSvg(rawSvg) : null;
      if (svgString === null || svgString === '') {
        if (svgString === '') {
          // 새니타이즈 실패: 오류 카드를 직접 삽입
          wrapper.innerHTML = RhwpViewer.RENDER_ERROR_HTML;
          wrapper.style.minHeight = '';
          this.scale = ZOOM_IDENTITY; this.translateX = 0;
          this.container.scrollTop = 0;
          this.onZoomChange?.(this.scale);
          this.currentPage = pageIndex;
        }
        renderSucceeded = true;
        this.finalizeRender(pageIndex, /* prefetch= */ false);
        return;
      }

      this.applySvgToWrapper(wrapper, svgString);
      this.currentPage = pageIndex;

      renderSucceeded = true;
      this.finalizeRender(pageIndex, /* prefetch= */ true);
    } finally {
      if (!renderSucceeded) {
        this.transitioning = false;
      }
    }
  }

  /**
   * 캐시 확인 + WASM 렌더링.
   * 캐시 히트: 즉시 SVG 문자열 반환.
   * 캐시 미스: 스켈레톤 표시 → rAF 양보 → WASM 렌더.
   * WASM 실패: wrapper에 오류 카드 삽입 후 null 반환.
   */
  private async getSvgString(
    pageIndex: number,
    wrapper: HTMLElement,
  ): Promise<string | null> {
    const cached = this.svgCache.get(pageIndex);
    if (cached) return cached;

    // 캐시 미스: 스켈레톤 표시 후 rAF로 한 프레임 양보 → WASM 렌더 중 사용자가 볼 수 있음
    wrapper.innerHTML = RhwpViewer.SKELETON_HTML;
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    try {
      const raw       = this.hwpViewer!.renderPageSvg(pageIndex);
      const svgString = sanitizeSvg(raw);
      if (svgString) this.cacheSet(pageIndex, svgString);
      // svgString === '' means sanitizer rejected the SVG — treat as render failure
      return svgString || null;
    } catch {
      // WASM 렌더링 실패 → 인라인 오류 카드 (앱 크래시 방지)
      wrapper.innerHTML = RhwpViewer.RENDER_ERROR_HTML;
      wrapper.style.minHeight = '';
      this.scale = ZOOM_IDENTITY; this.translateX = 0;
      this.container.scrollTop = 0;
      this.onZoomChange?.(this.scale);
      this.currentPage = pageIndex;
      return null;
    }
  }

  /**
   * wrapper에 SVG 문자열을 삽입하고 스타일·트랜스폼을 적용.
   * 페이지 전환 시 줌/팬을 ZOOM_IDENTITY로 리셋.
   */
  private applySvgToWrapper(wrapper: HTMLElement, svgString: string): void {
    wrapper.innerHTML = svgString;

    this.scale      = ZOOM_IDENTITY;
    this.translateX = 0;
    wrapper.style.minHeight = '';
    this.container.scrollTop = 0;
    this.onZoomChange?.(this.scale);

    const svgEl = wrapper.querySelector('svg');
    if (svgEl) {
      svgEl.style.maxWidth = '100%';
      svgEl.style.height   = 'auto';
      svgEl.style.display  = 'block';
      this.applyTransform(svgEl);
    }
  }

  /**
   * rAF 안에서 페이지 전환 완료 후 상태를 업데이트하고,
   * 성공 경로에서는 인접 페이지 프리렌더링을 트리거.
   * fade-in 타이밍을 보존하기 위해 transitioning = false도 여기서 해제.
   */
  private finalizeRender(pageIndex: number, prefetch: boolean): void {
    requestAnimationFrame(() => {
      this.container.classList.remove('page-exit');
      this.transitioning = false;
      this.onPageChange?.(this.currentPage, this.pageCount);
      if (prefetch) this.prefetchAdjacent(pageIndex);
    });
  }

  // ── 인접 페이지 프리렌더링 ────────────────────────────────

  /**
   * 현재 페이지 ±1 페이지를 백그라운드에서 미리 렌더링해 캐시에 저장.
   * requestIdleCallback (지원 시) 또는 setTimeout으로 메인 스레드 블로킹 방지.
   * 다음 페이지 이동 시 캐시에서 즉시 꺼내 스켈레톤 없이 표시 가능.
   */
  private prefetchAdjacent(centerPage: number): void {
    if (!this.hwpViewer) return;

    const targets = [centerPage + 1, centerPage - 1].filter(
      p => p >= 0 && p < this.pageCount && !this.svgCache.has(p)
    );
    if (targets.length === 0) return;

    const doFetch = () => {
      for (const p of targets) {
        if (!this.hwpViewer || this.svgCache.has(p)) continue;
        try {
          const raw  = this.hwpViewer.renderPageSvg(p);
          const safe = sanitizeSvg(raw);
          if (safe) this.cacheSet(p, safe);
        } catch { /* 프리렌더 실패는 무시 — 실제 이동 시 재시도 */ }
      }
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(doFetch, { timeout: 1500 });
    } else {
      setTimeout(doFetch, 150);
    }
  }

  // ── 캐시 관리 ────────────────────────────────────────────

  /** LRU 근사: 캐시 상한 초과 시 가장 오래된 항목(첫 삽입) 제거. */
  private cacheSet(idx: number, svg: string): void {
    this.svgCache.set(idx, svg);
    if (this.svgCache.size > SVG_CACHE_MAX) {
      this.svgCache.delete(this.svgCache.keys().next().value!);
    }
  }

  // ── 스켈레톤 / 렌더링 오류 HTML ─────────────────────────

  private static readonly SKELETON_HTML = `
    <div class="page-skeleton" aria-hidden="true">
      <div class="skeleton-block" style="width:55%;height:18px;margin-bottom:6px"></div>
      <div class="skeleton-block" style="width:100%"></div>
      <div class="skeleton-block" style="width:92%"></div>
      <div class="skeleton-block" style="width:100%"></div>
      <div class="skeleton-block" style="width:88%"></div>
      <div class="skeleton-block" style="width:100%"></div>
      <div class="skeleton-block" style="width:76%"></div>
      <div class="skeleton-block" style="width:100%"></div>
      <div class="skeleton-block" style="width:95%"></div>
      <div class="skeleton-block" style="width:60%"></div>
      <div class="skeleton-block" style="width:100%"></div>
      <div class="skeleton-block" style="width:83%"></div>
    </div>`.trim();

  private static readonly RENDER_ERROR_HTML = `
    <div class="page-render-error" role="alert">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
        <path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <p>이 페이지를 렌더링할 수 없습니다.</p>
    </div>`.trim();

  // ── 페이지 탐색 ───────────────────────────────────────────

  nextPage(): boolean {
    if (this.transitioning) return false;
    if (this.currentPage >= this.pageCount - 1) return false;
    void this.renderPage(this.currentPage + 1);
    return true;
  }

  prevPage(): boolean {
    if (this.transitioning) return false;
    if (this.currentPage <= 0) return false;
    void this.renderPage(this.currentPage - 1);
    return true;
  }

  goToPage(index: number): void {
    if (this.transitioning) return;
    const clamped = Math.max(0, Math.min(index, this.pageCount - 1));
    if (clamped === this.currentPage) return;
    void this.renderPage(clamped);
  }

  // ── 줌 ───────────────────────────────────────────────────

  setZoom(scale: number, viewportCX?: number, viewportCY?: number): void {
    const prev  = this.scale;
    const next  = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
    const ratio = next / prev;

    this.scale = next;
    // wrapper 높이를 먼저 확장해야 scrollTop을 유효 범위 내에서 설정 가능
    this.updateWrapperHeight();

    if (viewportCX !== undefined && viewportCY !== undefined && ratio !== 1) {
      const rect  = this.container.getBoundingClientRect();
      // X: transform 기반 (수평 중앙 고정점)
      const relCX = viewportCX - (rect.left + rect.width / 2);
      this.translateX = relCX * (1 - ratio) + ratio * this.translateX;
      // Y: scrollTop 기반 (핀치 중심점 고정)
      const focalY   = viewportCY - rect.top;
      const newScroll = (this.container.scrollTop + focalY) * ratio - focalY;
      this.container.scrollTop = Math.max(0, newScroll);
    }

    if (next <= ZOOM_IDENTITY) {
      this.translateX = 0;
      this.container.scrollTop = 0;
    } else {
      this.clampTranslateX();
    }

    const svgEl = this.container.querySelector('svg');
    if (svgEl) this.applyTransform(svgEl);

    this.onZoomChange?.(this.scale);
  }

  setZoomAnimated(scale: number, viewportCX?: number, viewportCY?: number): void {
    const svgEl = this.container.querySelector<HTMLElement>('svg');
    if (!svgEl) {
      this.setZoom(scale, viewportCX, viewportCY);
      return;
    }
    svgEl.style.transition = `transform ${ZOOM_ANIMATED_MS}ms ${ZOOM_ANIMATED_EASING}`;
    this.setZoom(scale, viewportCX, viewportCY);

    // { once: true }: 트랜지션 취소·요소 교체 시에도 리스너 누수 방지
    // 타임아웃 폴백: transitionend가 발화하지 않는 경우(요소 detach 등) cleanup 보장
    const cleanup = () => {
      clearTimeout(fallback);
      svgEl.style.transition = '';
    };
    const fallback = setTimeout(cleanup, ZOOM_ANIMATED_MS + 50);
    svgEl.addEventListener('transitionend', cleanup, { once: true });
  }

  resetZoom(): void { this.setZoomAnimated(1.0); }

  pan(dx: number, dy: number): void {
    if (this.scale <= ZOOM_IDENTITY) return;
    this.translateX += dx;
    this.clampTranslateX();
    // dy > 0: 손가락 아래로 → 위 내용 보기 → scrollTop 감소
    this.container.scrollTop = Math.max(0, this.container.scrollTop - dy);

    const svgEl = this.container.querySelector('svg');
    if (svgEl) this.applyTransform(svgEl);
  }

  // ── getter ────────────────────────────────────────────────

  getZoom(): number          { return this.scale; }
  getPageCount(): number     { return this.pageCount; }
  getCurrentPage(): number   { return this.currentPage; }
  isInitialized(): boolean   { return this.initialized; }
  isTransitioning(): boolean { return this.transitioning; }

  // ── private ───────────────────────────────────────────────

  private applyTransform(el: Element): void {
    (el as HTMLElement).style.transform =
      `translateX(${this.translateX}px) scale(${this.scale})`;
  }

  // X축만 clamp: Y축은 container.scrollTop이 처리
  private clampTranslateX(): void {
    const svgEl = this.container.querySelector<SVGSVGElement>('svg');
    if (!svgEl || this.scale <= ZOOM_IDENTITY) return;

    // clientWidth가 0인 경우 컨테이너 너비로 대체 (SVG는 max-width:100% 이므로 동일)
    const svgW = svgEl.clientWidth || this.container.clientWidth;
    const maxX = Math.max(0, (svgW * this.scale - this.container.clientWidth) / 2);
    this.translateX = Math.max(-maxX, Math.min(maxX, this.translateX));
  }

  // 확대 시 page-wrapper의 minHeight를 SVG 시각 높이로 확장.
  // overflow-y:auto 컨테이너가 이 영역을 스크롤할 수 있게 된다.
  private updateWrapperHeight(): void {
    const wrapper = this.container.querySelector<HTMLElement>('.page-wrapper');
    if (!wrapper) return;
    if (this.scale <= ZOOM_IDENTITY) {
      wrapper.style.minHeight = '';
      return;
    }
    const svgEl = this.container.querySelector<SVGSVGElement>('svg');
    let svgH = svgEl?.clientHeight ?? 0;
    if (svgH === 0 && svgEl) {
      const vb = svgEl.viewBox?.baseVal;
      if (vb && vb.width > 0) {
        const svgW = svgEl.clientWidth || this.container.clientWidth;
        svgH = svgW * vb.height / vb.width;
      }
    }
    if (svgH > 0) {
      wrapper.style.minHeight = `${Math.ceil(svgH * this.scale)}px`;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
