// v1.1: IndexedDB 최근 파일 기능 구현 예정.
// 현재는 no-op으로 앱 초기화 흐름만 유지.

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  openedAt: number;
}

export class RecentFileStorage {
  async init(): Promise<void> {
    // TODO v1.1: IndexedDB open & schema migration
  }

  async getRecentFiles(): Promise<RecentFile[]> {
    return [];
  }

  async addRecentFile(_file: Pick<RecentFile, 'name' | 'size'>): Promise<void> {
    // TODO v1.1
  }

  async removeRecentFile(_id: string): Promise<void> {
    // TODO v1.1
  }
}
