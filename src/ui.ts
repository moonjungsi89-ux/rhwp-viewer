export class UIController {
  private homeScreen     = document.getElementById('home-screen')!;
  private viewerScreen   = document.getElementById('viewer-screen')!;
  private errorScreen    = document.getElementById('error-screen')!;
  private toolbar        = document.getElementById('toolbar')!;
  private pageNav        = document.getElementById('page-nav')!;
  private fileNameEl     = document.getElementById('file-name')!;
  private pageInfoEl     = document.getElementById('page-info')!;
  private loadingOverlay = document.getElementById('loading-overlay')!;
  private loadingText    = document.getElementById('loading-text')!;
  private loadingProgress = document.getElementById('loading-progress')!;
  private loadingBar     = document.getElementById('loading-bar')!;
  private offlineBanner  = document.getElementById('offline-banner')!;

  private isImmersive = false;

  // ── 화면 전환 ───────────────────────────

  showHome(): void {
    this.showScreen(this.homeScreen);
    this.hideLoading();
  }

  showViewer(filename: string): void {
    this.fileNameEl.textContent = filename;
    this.showScreen(this.viewerScreen);
    this.showChrome();
  }

  /**
   * 에러 화면 표시.
   * @param message  사용자에게 보여줄 메시지
   * @param onRetry  "다시 시도" 버튼 콜백 (없으면 버튼 숨김)
   * @param details  접기/펼치기 상세 (스택 트레이스 등, 개발자용)
   */
  showError(message: string, onRetry?: () => void, details?: string): void {
    document.getElementById('error-message')!.textContent = message;

    const retryBtn = document.getElementById('error-retry-btn') as HTMLButtonElement;
    retryBtn.hidden = !onRetry;
    if (onRetry) retryBtn.onclick = onRetry;

    // 홈 복귀 보조 버튼 — retry 유무와 관계없이 항상 홈으로 돌아갈 출구 제공
    const homeBtn = document.getElementById('error-home-btn') as HTMLButtonElement;
    homeBtn.onclick = () => this.showHome();

    const detailsEl  = document.getElementById('error-details')!;
    const detailText = document.getElementById('error-detail-text')!;
    if (details) {
      detailText.textContent = details;
      detailsEl.hidden = false;
      (detailsEl as HTMLDetailsElement).open = false; // 기본 접힘 상태
    } else {
      detailsEl.hidden = true;
    }

    this.showScreen(this.errorScreen);
    this.hideLoading();
  }

  // ── 몰입 모드 ───────────────────────────

  toggleImmersive(): void {
    if (this.isImmersive) {
      this.showChrome();
    } else {
      this.hideChrome();
    }
  }

  showChrome(): void {
    this.toolbar.classList.remove('hidden');
    this.pageNav.classList.remove('hidden');
    this.viewerScreen.classList.remove('immersive');
    this.isImmersive = false;
  }

  // ── 로딩 ───────────────────────────────

  /**
   * 로딩 오버레이 표시.
   * @param message  스피너 아래 텍스트
   * @param progress 진행률 0–100. 제공 시 진행률 바 표시, 미제공 시 숨김.
   */
  showLoading(message?: string, progress?: number): void {
    this.loadingText.textContent = message ?? '문서를 여는 중...';

    if (progress !== undefined) {
      this.loadingBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
      this.loadingProgress.hidden = false;
    } else {
      this.loadingProgress.hidden = true;
    }

    this.loadingOverlay.hidden = false;
  }

  hideLoading(): void {
    this.loadingOverlay.hidden = true;
    this.loadingProgress.hidden = true;
    this.loadingBar.style.width = '0%';
  }

  // ── 페이지 상태 ─────────────────────────

  updatePageInfo(current: number, total: number): void {
    this.pageInfoEl.textContent = `${current + 1} / ${total}`;
  }

  updateNavButtons(current: number, total: number): void {
    (document.getElementById('prev-btn') as HTMLButtonElement).disabled = current === 0;
    (document.getElementById('next-btn') as HTMLButtonElement).disabled = current === total - 1;
  }

  // ── 오프라인 상태 ───────────────────────

  showOfflineBanner(): void {
    this.offlineBanner.hidden = false;
  }

  hideOfflineBanner(): void {
    this.offlineBanner.hidden = true;
  }

  // ── private ─────────────────────────────

  private hideChrome(): void {
    this.toolbar.classList.add('hidden');
    this.pageNav.classList.add('hidden');
    this.viewerScreen.classList.add('immersive');
    this.isImmersive = true;
  }

  private showScreen(target: HTMLElement): void {
    this.homeScreen.hidden   = true;
    this.viewerScreen.hidden = true;
    this.errorScreen.hidden  = true;
    target.hidden = false;
  }
}
