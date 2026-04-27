export type FileOpenCallback = (file: File, buffer: ArrayBuffer) => void;
export type FileErrorCallback = (err: Error) => void;

type FileValidation = { valid: true } | { valid: false; reason: string };

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export class FileHandler {
  private onFileOpen: FileOpenCallback;
  private onError:    FileErrorCallback;
  private fileInput:  HTMLInputElement;

  constructor(onFileOpen: FileOpenCallback, onError: FileErrorCallback) {
    this.onFileOpen = onFileOpen;
    this.onError    = onError;
    this.fileInput  = document.getElementById('file-input') as HTMLInputElement;
  }

  // ── 1. input[type=file] ───────────────────────────────────────────
  // 지원: 전 브라우저, 전 플랫폼

  /** 파일 선택 다이얼로그 열기.
   * showOpenFilePicker (Chrome 86+, Android "내 파일" 직접 열림) 우선,
   * 미지원 브라우저(Samsung Internet, Firefox, Safari)는 input.click() 폴백. */
  openFilePicker(): void {
    if ('showOpenFilePicker' in window) {
      (window as Window & { showOpenFilePicker: Function }).showOpenFilePicker({
        types: [{ description: 'HWP 문서', accept: { 'application/octet-stream': ['.hwp', '.hwpx'] } }],
        multiple: false,
      })
        .then((handles: FileSystemFileHandle[]) => handles[0].getFile())
        .then((file: File) => this.processFile(file))
        .catch(() => { /* 사용자 취소 */ });
      return;
    }
    this.fileInput.click();
  }

  /** input change 이벤트 바인딩. */
  attachInputHandler(): void {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (!file) return;
      this.fileInput.value = ''; // 같은 파일을 연속 선택 가능하게
      void this.processFile(file);
    });
  }

  // ── 2. 드래그 앤 드롭 ────────────────────────────────────────────
  // 지원: 데스크톱 브라우저 전반 (CSS에서 hover:hover 기기만 표시)
  // 미지원: iOS Safari (draggable 파일 없음), Android

  /**
   * 드래그 앤 드롭 이벤트 바인딩.
   * @param container   dragover/drop 이벤트를 수신할 요소 (보통 #home-screen 전체)
   * @param dropZone    시각 피드백(drag-over 클래스)을 적용할 요소 (보통 #drop-zone)
   *                    생략 시 container와 동일.
   */
  attachDropZone(container: HTMLElement, dropZone?: HTMLElement): void {
    const highlight = dropZone ?? container;

    container.addEventListener('dragover', (e) => {
      // 파일 드롭만 허용 (링크·텍스트 드래그 무시)
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      highlight.classList.add('drag-over');
    });

    container.addEventListener('dragleave', (e) => {
      // 자식 요소로 포커스 이동 시 발생하는 false leave 무시
      if (container.contains(e.relatedTarget as Node)) return;
      highlight.classList.remove('drag-over');
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      highlight.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      void this.processFile(file);
    });
  }

  // ── 3. File Handling API ──────────────────────────────────────────
  // 지원: Chrome 102+, Edge 102+ (데스크톱 PWA 설치 후)
  // 미지원: iOS Safari, 모바일 Chrome, Firefox → input[type=file]로 폴백
  // manifest.json의 file_handlers 선언과 함께 동작

  attachFileHandlingAPI(): void {
    if (!('launchQueue' in window)) return;

    (window as Window & { launchQueue: LaunchQueue }).launchQueue.setConsumer(
      async (launchParams) => {
        const handle = launchParams.files[0];
        if (!handle) return;
        const file = await handle.getFile();
        void this.processFile(file);
      }
    );
  }

  // ── 4. Share Target API ───────────────────────────────────────────
  // 지원: Android Chrome (PWA 설치 후), 일부 데스크톱 Chromium
  // 미지원: iOS Safari, Firefox
  //
  // 동작 흐름:
  //   ① 다른 앱 → "공유" → 알뷰어 선택
  //   ② 브라우저가 POST /share (multipart/form-data) 전송
  //   ③ Service Worker가 폼에서 파일 추출 → /_share-pending 캐시에 저장 → /?share=1 리다이렉트
  //   ④ 이 함수가 /?share=1 감지 → SW에서 /_share-pending fetch → processFile

  async attachShareTarget(): Promise<void> {
    if (!location.search.includes('share=1')) return;

    // 뒤로가기·새로고침 시 재실행 방지
    window.history.replaceState({}, '', '/');

    try {
      const response = await fetch('/_share-pending');
      if (!response.ok) return;

      // x-filename은 SW가 encodeURIComponent()로 인코딩해 저장한 값.
      // decodeURIComponent 실패 또는 경로 구분자 포함 시 안전한 폴백 사용.
      const rawName = response.headers.get('x-filename') ?? '';
      let filename = 'shared.hwp';
      try {
        const decoded = decodeURIComponent(rawName);
        // 경로 구분자, null byte 차단
        if (decoded && !/[/\\\x00]/.test(decoded)) {
          filename = decoded;
        }
      } catch { /* 폴백 유지 */ }
      const buffer   = await response.arrayBuffer();
      const file     = new File([buffer], filename);
      void this.processFile(file);
    } catch {
      this.onError(new Error('공유된 파일을 불러오는 데 실패했습니다.'));
    }
  }

  // ── 5. URL 파라미터 ───────────────────────────────────────────────
  // 사용법: ?url=https://example.com/document.hwp
  // 제약: CORS — 대상 서버가 Access-Control-Allow-Origin을 허용해야 함.
  //       동일 출처, 사내 인트라넷, CORS 설정된 CDN에서만 실용적.
  //       임의의 외부 URL은 CORS 오류로 실패할 수 있음.

  attachUrlParam(): void {
    const url = new URLSearchParams(location.search).get('url');
    if (!url) return;

    window.history.replaceState({}, '', '/');

    // 보안: http/https 외 스키마(file://, data:, ftp:// 등) 차단 — SSRF 방지
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.onError(new Error('유효하지 않은 URL입니다.'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      this.onError(new Error('http 또는 https URL만 지원합니다.'));
      return;
    }

    fetch(url, { mode: 'cors' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);

        // Content-Length 기반 조기 차단 (응답 수신 전)
        const contentLength = r.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
          throw new Error('파일 크기가 50MB를 초과합니다.');
        }

        const buffer = await r.arrayBuffer();

        // 실제 수신 크기 재검증 (Content-Length 없거나 청크 전송인 경우 대비)
        if (buffer.byteLength > MAX_FILE_SIZE) {
          throw new Error('파일 크기가 50MB를 초과합니다.');
        }

        // 파일명: URL 경로의 마지막 세그먼트만 사용.
        // decodeURIComponent 실패 시 'document.hwp'로 폴백.
        // path traversal 방지: 슬래시/역슬래시를 포함한 이름은 차단.
        let filename = 'document.hwp';
        try {
          const raw = new URL(url).pathname.split('/').pop() ?? '';
          const decoded = decodeURIComponent(raw).split('?')[0];
          // 경로 구분자가 포함되면 폴백
          if (decoded && !/[/\\]/.test(decoded)) {
            filename = decoded;
          }
        } catch { /* 폴백 유지 */ }

        const file = new File([buffer], filename);
        return this.processFile(file);
      })
      .catch((err: unknown) => {
        this.onError(new Error(
          `URL에서 파일을 불러올 수 없습니다 (CORS 제한일 수 있음): ${
            err instanceof Error ? err.message : String(err)
          }`
        ));
      });
  }

  // ── 공통: 검증 및 처리 ────────────────────────────────────────────

  /**
   * HWP/HWPX 파일 유효성 검사.
   * 확장자 + 크기 + 매직 바이트를 모두 확인.
   * OLE2 (HWP) = D0 CF 11 E0 / ZIP (HWPX) = 50 4B 03 04
   */
  validate(file: File, buffer: ArrayBuffer): FileValidation {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'hwp' && ext !== 'hwpx') {
      return { valid: false, reason: 'HWP 또는 HWPX 파일만 지원합니다.' };
    }
    if (file.size === 0) {
      return { valid: false, reason: '빈 파일입니다.' };
    }
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, reason: '50MB를 초과하는 파일은 열 수 없습니다.' };
    }

    const h      = new Uint8Array(buffer, 0, 4);
    const isOle2 = h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;
    const isZip  = h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04;
    if (!isOle2 && !isZip) {
      return {
        valid: false,
        reason: '파일을 열 수 없습니다. 손상되었거나 지원하지 않는 형식입니다.',
      };
    }

    return { valid: true };
  }

  /** File → ArrayBuffer → validate → onFileOpen (또는 onError). */
  async processFile(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      const result = this.validate(file, buffer);
      if (!result.valid) {
        this.onError(new Error(result.reason));
        return;
      }
      this.onFileOpen(file, buffer);
    } catch {
      this.onError(new Error('파일을 읽는 중 오류가 발생했습니다.'));
    }
  }
}

// ── 외부 API 타입 선언 (lib.dom 미포함) ──────────────────────────────

// File Handling API (W3C 초안, Chrome 102+)
interface LaunchParams { files: FileSystemFileHandle[]; }
interface LaunchQueue  { setConsumer(cb: (p: LaunchParams) => Promise<void>): void; }
