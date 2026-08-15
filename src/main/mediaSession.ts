import os from "node:os";

import { events as lifecycleEvents } from "./lifecycle";
import PlaybackController from "./playback/PlaybackController";
import { PlaybackChange } from "./playback/types";
import {
  MediaSessionAdapter,
  NoopAdapter,
} from "./playback/adapters/MediaSessionAdapter";
import PlayerCommandRouter from "./playback/PlayerCommandRouter";

/** Track metadata passed through the frozen `player.setInfo` seam. */
export interface Metadata {
  id: string;
  title: string;
  artist: string;
  album: string;
  url: string;
}

/** Single source of truth for playback state (see playback/PlaybackController). */
export const playbackController = new PlaybackController();

let adapter: MediaSessionAdapter = new NoopAdapter();

export async function createMediaSession(): Promise<void> {
  switch (os.platform()) {
    case "linux":
      // MPRIS is Linux-only (`@open-orpheus/dbus`); load the adapter only here.
      adapter = new (
        await import("./playback/adapters/MprisAdapter")
      ).default();
      break;
    case "win32":
      // `@open-orpheus/smtc` is a Windows-only native module, so it is only
      // loaded on this platform (kept out of other platform bundles).
      adapter = new (await import("./playback/adapters/SmtcAdapter")).default();
      break;
    case "darwin":
      // `@open-orpheus/nowplaying` is a macOS-only native module (MPNowPlayingInfoCenter).
      adapter = new (
        await import("./playback/adapters/NowPlayingAdapter")
      ).default();
      break;
    default:
      console.warn("Media session is not available on this platform.");
  }

  // OS media-session commands → renderer.
  new PlayerCommandRouter(adapter);

  // Derived state → OS media-session adapter.
  playbackController.on("trackchanged", ({ data }) => adapter.onTrack(data));
  playbackController.on("statuschanged", ({ data }) => adapter.onStatus(data));
  playbackController.on("positionchanged", ({ data }) =>
    adapter.onPosition(data.position, data.seeked)
  );
  playbackController.on("durationchanged", ({ data }) =>
    adapter.onDuration(data)
  );
  playbackController.on("ratechanged", ({ data }) => adapter.onRate(data));
  playbackController.on("volumechanged", ({ data }) => adapter.onVolume(data));
}

// Frozen seam: `player.setInfo` (registerCallHandler) calls this.
export const mediaSession = {
  setMetadata(metadata: Metadata | null): void {
    playbackController.setTrack(metadata);
  },
};

lifecycleEvents.on("mainwindowcreated", ({ data: mainWindow }) => {
  mainWindow.webContents.ipc.on("player.timeupdate", (e, time) => {
    playbackController.applyPosition(time);
  });

  mainWindow.webContents.ipc.on("player.seeked", (e, time) => {
    playbackController.applyPosition(time, true);
  });

  mainWindow.webContents.ipc.on("player.durationchange", (e, duration) => {
    playbackController.applyDuration(duration);
  });

  mainWindow.webContents.ipc.on("player.playbackratechange", (e, rate) => {
    playbackController.applyRate(rate);
  });

  mainWindow.webContents.ipc.on("player.playbackchange", (e, change) => {
    playbackController.applyPlaybackChange(change as PlaybackChange);
  });

  mainWindow.webContents.ipc.on("player.volumechange", (e, volume) => {
    playbackController.applyVolume(volume);
  });
});
