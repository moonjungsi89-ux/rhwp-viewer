export type GestureCallbacks = {
  onSwipeLeft:    () => void;
  onSwipeRight:   () => void;
  onTap:          (x: number, y: number) => void;
  onDoubleTap:    (x: number, y: number) => void;
  onPinchChange:  (scale: number, cx: number, cy: number) => void;
  onPinchEnd:     (finalScale: number, cx: number, cy: number) => void;
  onPan:          (dx: number, dy: number) => void;
};

// ── 상수 ──────────────────────────────────────────────────────────
const SWIPE_THRESHOLD_PX  = 50;   // 이 거리 이상 가로 이동해야 페이지 전환
const SWIPE_RESISTANCE    = 0.35; // 경계(첫/끝 페이지)에서 이동 감쇠 계수
const TAP_MAX_MS          = 300;  // 이 시간 이내 터치 종료 시 탭으로 판정
const TAP_MAX_DIST_PX     = 10;   // 이 거리 이내 이동 시 탭으로 판정
const SNAP_DURATION_MS    = 260;  // snap-back CSS transition 길이
const DOUBLE_TAP_MAX_MS   = 300;  // 두 탭 사이 최대 간격 (더블 탭 판정)
const DOUBLE_TAP_MAX_DIST = 30;   // 두 탭 사이 최대 거리 (더블 탭 판정)

/**
 * 제스처 우선순위 및 전환 규칙:
 *
 *  터치 수  │ scale = 1.0          │ scale > 1.0
 * ──────────┼──────────────────────┼──────────────────────
 *  1손가락  │ detecting → swipe/   │ panning (팬)
 *           │ scroll / tap         │ + 탭 판정(정지 시)
 *  2손가락  │ pinching (핀치 줌)   │ pinching
 *  3손가락+ │ 무시                 │ 무시
 *
 *  페이지 전환 중(isTransitioning) → 모든 새 제스처 차단
 */
type GestureState =
  | 'idle'        // 터치 없음
  | 'detecting'   // 방향 미결정 (5px 미만 이동)
  | 'swiping'     // 가로 스와이프 확정 → 브라우저 스크롤 차단
  | 'scrolling'   // 세로 스크롤 → 브라우저 위임
  | 'pinching'    // 2손가락 핀치
  | 'panning';    // 확대 상태 1손가락 팬

export class TouchHandler {
  private el: HTMLElement;
  private callbacks: GestureCallbacks;

  // 외부에서 동기화: 현재 줌 레벨 (scale > 1 이면 pan 모드)
  private currentScale = 1.0;
  // 외부에서 주입: 페이지 전환 중 여부 (전환 중 → 제스처 차단)
  private isTransitioning: () => boolean = () => false;
  // 외부에서 주입: 경계 판단 (경계에서 스와이프 시 저항감)
  private canGoPrev: () => boolean = () => true;
  private canGoNext: () => boolean = () => true;

  // 1손가락 추적
  private startX    = 0;
  private startY    = 0;
  private startTime = 0;
  private currentDx = 0;   // 스와이프 누적 이동량
  private prevX     = 0;   // 팬 델타 계산용 이전 위치
  private prevY     = 0;
  private state: GestureState = 'idle';

  // 2손가락 핀치 추적
  private pinchStartDist  = 0;
  private pinchStartScale = 1.0;
  private pinchCenterX    = 0;
  private pinchCenterY    = 0;

  // 더블 탭 추적
  private lastTapTime = 0;
  private lastTapX    = 0;
  private lastTapY    = 0;
  private tapTimer: ReturnType<typeof setTimeout> | null = null;

  // bound handlers — detach에서 동일 참조 필요
  private readonly _onStart:  (e: TouchEvent) => void;
  private readonly _onMove:   (e: TouchEvent) => void;
  private readonly _onEnd:    (e: TouchEvent) => void;

  constructor(el: HTMLElement, callbacks: GestureCallbacks) {
    this.el = el;
    this.callbacks = callbacks;
    this._onStart = this.onTouchStart.bind(this);
    this._onMove  = this.onTouchMove.bind(this);
    this._onEnd   = this.onTouchEnd.bind(this);
  }

  attach(): void {
    // touchstart: passive OK (스크롤 차단 필요 없음)
    this.el.addEventListener('touchstart', this._onStart, { passive: true });
    // touchmove: passive:false 필수 — swiping/pinching/panning 시 e.preventDefault() 호출
    this.el.addEventListener('touchmove',  this._onMove,  { passive: false });
    this.el.addEventListener('touchend',    this._onEnd,  { passive: true });
    this.el.addEventListener('touchcancel', this._onEnd,  { passive: true });
  }

  detach(): void {
    this.el.removeEventListener('touchstart', this._onStart);
    this.el.removeEventListener('touchmove',  this._onMove);
    this.el.removeEventListener('touchend',   this._onEnd);
    this.el.removeEventListener('touchcancel',this._onEnd);
  }

  /** 뷰어의 현재 줌 레벨 동기화. scale > 1 이면 swipe 대신 pan 모드 진입. */
  setCurrentScale(scale: number): void {
    this.currentScale = scale;
  }

  /** 페이지 전환 중 여부 주입. 전환 중이면 touchstart에서 모든 제스처를 차단. */
  setTransitionChecker(fn: () => boolean): void {
    this.isTransitioning = fn;
  }

  /** 경계 판단 함수 주입. 경계에서 스와이프 시 저항감 표현에 사용. */
  setBoundaryCheckers(canGoPrev: () => boolean, canGoNext: () => boolean): void {
    this.canGoPrev = canGoPrev;
    this.canGoNext = canGoNext;
  }

  // ── private: 이벤트 핸들러 ──────────────────────────────────────

  private onTouchStart(e: TouchEvent): void {
    // 3손가락 이상: 시스템 제스처(스크린샷 등)와 충돌 방지 — 완전 무시
    if (e.touches.length > 2) return;

    // 페이지 전환 애니메이션 중: 모든 새 제스처 차단
    if (this.isTransitioning()) {
      this.state = 'idle';
      return;
    }

    // 2손가락 → 핀치 줌
    if (e.touches.length === 2) {
      this.state = 'pinching';
      const [a, b] = [e.touches[0], e.touches[1]];
      this.pinchStartDist  = dist(a, b);
      this.pinchStartScale = this.currentScale;
      this.pinchCenterX    = (a.clientX + b.clientX) / 2;
      this.pinchCenterY    = (a.clientY + b.clientY) / 2;
      return;
    }

    // 1손가락
    const t = e.touches[0];
    this.startX    = t.clientX;
    this.startY    = t.clientY;
    this.prevX     = t.clientX;
    this.prevY     = t.clientY;
    this.startTime = Date.now();
    this.currentDx = 0;

    // scale > 1.0: swipe 비활성, pan 모드 진입
    // scale = 1.0: 방향 탐지 후 swipe/scroll/tap 결정
    this.state = this.currentScale > 1.0 ? 'panning' : 'detecting';
  }

  private onTouchMove(e: TouchEvent): void {
    if (this.state === 'idle') return;

    // 3손가락 이상이면 모든 처리 중단
    if (e.touches.length > 2) return;

    // 1손가락 → 2손가락 추가: 현재 상태를 pinching으로 전환
    // (detecting/swiping/panning 모두 핀치에 양보)
    if (e.touches.length === 2 && this.state !== 'pinching') {
      this.state = 'pinching';
      const [a, b] = [e.touches[0], e.touches[1]];
      this.pinchStartDist  = dist(a, b);
      this.pinchStartScale = this.currentScale;
      this.pinchCenterX    = (a.clientX + b.clientX) / 2;
      this.pinchCenterY    = (a.clientY + b.clientY) / 2;
      this.resetFeedback(false); // 스와이프 피드백이 남아 있으면 즉시 제거
      e.preventDefault();
      return;
    }

    // ── 2손가락 핀치 ─────────────────────────────────────────────
    if (this.state === 'pinching') {
      if (e.touches.length < 2) return;
      e.preventDefault(); // 브라우저 기본 핀치 줌 차단
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = dist(a, b);
      if (this.pinchStartDist === 0) return;
      const newScale = this.pinchStartScale * (d / this.pinchStartDist);
      this.pinchCenterX = (a.clientX + b.clientX) / 2;
      this.pinchCenterY = (a.clientY + b.clientY) / 2;
      this.callbacks.onPinchChange(newScale, this.pinchCenterX, this.pinchCenterY);
      return;
    }

    // ── 1손가락 팬 (scale > 1.0) ──────────────────────────────────
    if (this.state === 'panning') {
      e.preventDefault(); // 브라우저 스크롤 차단
      const t  = e.touches[0];
      const dx = t.clientX - this.prevX;
      const dy = t.clientY - this.prevY;
      this.prevX = t.clientX;
      this.prevY = t.clientY;
      this.callbacks.onPan(dx, dy);
      return;
    }

    // ── 1손가락 스와이프/스크롤 (scale = 1.0) ─────────────────────
    // scale이 1.0을 초과한 채 detecting/swiping 상태가 됐다면 무시
    // (double-tap 줌인 직후 손가락을 아직 떼지 않은 경우 등)
    if (this.currentScale > 1.0) return;

    const t  = e.touches[0];
    const dx = t.clientX - this.startX;
    const dy = t.clientY - this.startY;

    if (this.state === 'detecting') {
      // 5px 미만이면 방향 미결정 유지
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      // 가로 성분이 크면 스와이프, 세로 성분이 크면 스크롤
      this.state = Math.abs(dx) >= Math.abs(dy) ? 'swiping' : 'scrolling';
    }

    // 세로 스크롤: 브라우저에 위임 (preventDefault 미호출)
    if (this.state === 'scrolling') return;

    if (this.state === 'swiping') {
      e.preventDefault(); // 가로 스와이프 확정 → 브라우저 스크롤 차단
      this.currentDx = dx;
      this.applyFeedback(dx);
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    const prevState = this.state;

    // ── 핀치 종료 ────────────────────────────────────────────────
    if (prevState === 'pinching') {
      // 남은 손가락 수에 따라 다음 상태 결정
      if (e.touches.length === 1) {
        // 손가락 하나가 남아 있으면 계속 팬/detecting 진입
        // (onPinchEnd는 먼저 발화 → setCurrentScale 동기 업데이트)
        this.callbacks.onPinchEnd(this.currentScale, this.pinchCenterX, this.pinchCenterY);
        const t    = e.touches[0];
        this.prevX = t.clientX;
        this.prevY = t.clientY;
        this.startX    = t.clientX;
        this.startY    = t.clientY;
        this.startTime = Date.now();
        this.state = this.currentScale > 1.0 ? 'panning' : 'detecting';
      } else {
        // 손가락 모두 뗌
        this.callbacks.onPinchEnd(this.currentScale, this.pinchCenterX, this.pinchCenterY);
        this.state = 'idle';
      }
      return;
    }

    this.state = 'idle';

    // ── 스와이프 종료 ─────────────────────────────────────────────
    if (prevState === 'swiping') {
      this.handleSwipeEnd();
      return;
    }

    // ── 팬 종료 — 정지 탭이면 더블탭 인식 허용 ────────────────────
    // scale > 1.0 상태에서도 더블탭으로 줌 아웃할 수 있어야 하므로
    // 거리/시간 조건을 만족하면 탭으로 처리
    if (prevState === 'panning') {
      const ch  = e.changedTouches[0];
      const d   = Math.hypot(ch.clientX - this.startX, ch.clientY - this.startY);
      const dur = Date.now() - this.startTime;
      if (d < TAP_MAX_DIST_PX && dur < TAP_MAX_MS) {
        this.handleTap(ch.clientX, ch.clientY);
      }
      return;
    }

    // ── 탭 판정 (detecting 상태에서 종료) ────────────────────────
    if (prevState === 'detecting') {
      const ch  = e.changedTouches[0];
      const d   = Math.hypot(ch.clientX - this.startX, ch.clientY - this.startY);
      const dur = Date.now() - this.startTime;
      if (d < TAP_MAX_DIST_PX && dur < TAP_MAX_MS) {
        this.handleTap(ch.clientX, ch.clientY);
      }
    }
  }

  // ── private: 스와이프 처리 ─────────────────────────────────────

  private handleSwipeEnd(): void {
    const dx    = this.currentDx;
    const absDx = Math.abs(dx);

    // 임계값 미달 → snap-back
    if (absDx < SWIPE_THRESHOLD_PX) {
      this.resetFeedback(true);
      return;
    }

    const goingLeft  = dx < 0; // 손가락 왼쪽 = 다음 페이지
    const atBoundary = goingLeft ? !this.canGoNext() : !this.canGoPrev();

    // 경계에서 스와이프 → snap-back (바운스 효과는 applyFeedback에서 적용)
    if (atBoundary) {
      this.resetFeedback(true);
      return;
    }

    // 성공: 피드백 즉시 제거 후 페이지 전환 (fade가 이어받음)
    this.resetFeedback(false);
    if (goingLeft) {
      this.callbacks.onSwipeLeft();
    } else {
      this.callbacks.onSwipeRight();
    }
  }

  // ── private: 탭 처리 ──────────────────────────────────────────

  private handleTap(x: number, y: number): void {
    const now = Date.now();
    const gap = now - this.lastTapTime;
    const d   = Math.hypot(x - this.lastTapX, y - this.lastTapY);

    if (gap < DOUBLE_TAP_MAX_MS && d < DOUBLE_TAP_MAX_DIST) {
      // 더블 탭: 보류 중인 싱글 탭 취소 후 즉시 발화
      if (this.tapTimer !== null) {
        clearTimeout(this.tapTimer);
        this.tapTimer = null;
      }
      // Date.now()로 설정: 0으로 초기화하면 세 번째 탭의 gap이 크게 계산되어
      // 싱글탭 타이머가 재등록되는 경쟁 상태 발생. now로 설정해 새 시퀀스 시작.
      this.lastTapTime = Date.now();
      this.callbacks.onDoubleTap(x, y);
      return;
    }

    this.lastTapTime = now;
    this.lastTapX    = x;
    this.lastTapY    = y;

    // 싱글 탭: 더블 탭 판정 윈도우(DOUBLE_TAP_MAX_MS) 후에 발화
    // 이 사이에 두 번째 탭이 오면 위 더블 탭 분기에서 타이머가 취소됨
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null;
      this.callbacks.onTap(x, y);
    }, DOUBLE_TAP_MAX_MS);
  }

  // ── private: 스와이프 시각 피드백 ─────────────────────────────

  /**
   * .page-wrapper를 dx만큼 translateX 이동.
   * 경계(첫/끝 페이지)에서는 SWIPE_RESISTANCE 계수로 감쇠 → 바운스 느낌.
   */
  private applyFeedback(dx: number): void {
    const wrapper = this.getWrapper();
    if (!wrapper) return;

    const atStart = dx > 0 && !this.canGoPrev();
    const atEnd   = dx < 0 && !this.canGoNext();
    const clamped = (atStart || atEnd) ? dx * SWIPE_RESISTANCE : dx;

    wrapper.style.transition = 'none';
    wrapper.style.transform  = `translateX(${clamped}px)`;
  }

  /**
   * .page-wrapper를 원위치.
   * animate=true: CSS transition으로 snap-back (임계값 미달 / 경계 스와이프).
   * animate=false: 즉시 리셋 (페이지 전환 직전, 피드백이 fade에 가려짐).
   */
  private resetFeedback(animate: boolean): void {
    const wrapper = this.getWrapper();
    if (!wrapper) return;

    if (animate) {
      wrapper.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
      wrapper.style.transform  = 'translateX(0)';
      // { once: true }: 트랜지션 취소·요소 교체 시에도 리스너 누수 방지
      // 타임아웃 폴백: transitionend가 발화하지 않는 경우 cleanup 보장
      const cleanup = () => {
        clearTimeout(fallback);
        wrapper!.style.transition = '';
        wrapper!.style.transform  = '';
      };
      const fallback = setTimeout(cleanup, SNAP_DURATION_MS + 50);
      wrapper.addEventListener('transitionend', cleanup, { once: true });
    } else {
      wrapper.style.transition = '';
      wrapper.style.transform  = '';
    }
  }

  private getWrapper(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>('.page-wrapper');
  }
}

function dist(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
