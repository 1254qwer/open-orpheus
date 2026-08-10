import type {
  DesktopLyricsPlayInfo,
  LyricsStyle,
} from "$sharedTypes/desktop-lyrics";

export interface DesktopLyricsContract {
  platform: NodeJS.Platform;
  events: {
    styleUpdate(callback: (style: LyricsStyle) => void): void;
    lockUpdate(callback: (locked: boolean) => void): void;
    offsetUpdate(callback: (offset: number) => void): void;
    playInfoUpdate(
      callback: (info: DesktopLyricsPlayInfo | null) => void
    ): void;
    blur(callback: () => void): void;
  };
  requestFullUpdate(): Promise<void>;
  dragWindow(): Promise<void>;
  changeOrientation(): Promise<void>;
  performAction(action: string): Promise<void>;
}

export interface DesktopLyricsPreviewContract {
  requestInit(): Promise<{ style: LyricsStyle; text: string }>;
  ready(): Promise<void>;
}
