import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import Emittery from "emittery";

import {
  MediaSession,
  PlaybackStatus as DbusPlaybackStatus,
} from "@open-orpheus/dbus";

import type { MprisMetadata } from "@open-orpheus/dbus";
import { cache } from "../../folders";
import { client } from "../../request";
import { imageSize } from "../../../util";
import { PlaybackStatus, TrackInfo } from "../types";
import {
  MediaSessionAdapter,
  PlayerCommandEvents,
} from "./MediaSessionAdapter";

const THUMBNAIL_CACHE_DIR = join(cache, "thumbnails");

// MPRIS uses microseconds, and we use seconds.
const TIME_RATIO = 1_000_000;

/** Maximum number of cached thumbnails to keep (oldest are evicted). */
const MAX_THUMBNAILS = 3;

/** Square size to request for album art (instead of the original image). */
const ARTWORK_SIZE = 512;

/** Linux MPRIS integration, backed by the `@open-orpheus/dbus` zbus module. */
export default class MprisAdapter
  extends Emittery<PlayerCommandEvents>
  implements MediaSessionAdapter
{
  private mediaSession: MediaSession;

  private metadata: TrackInfo | null = null;
  private artUrl: string | null = null;
  private status: PlaybackStatus = PlaybackStatus.Stopped;
  private position: number | null = null;
  private duration: number | null = null;
  private rate = 1;

  constructor() {
    super();

    let mprisName = "open-orpheus";
    let desktopEntry = "open-orpheus";
    if (process.env.FLATPAK_ID) {
      mprisName = desktopEntry = process.env.FLATPAK_ID;
    }

    this.mediaSession = new MediaSession(
      mprisName,
      "Open Orpheus",
      desktopEntry
    );

    this.mediaSession.setEventHandler((err, event) => {
      switch (event.type) {
        case "Play":
          this.emit("play");
          break;
        case "Pause":
          this.emit("pause");
          break;
        case "Next":
          this.emit("next");
          break;
        case "Previous":
          this.emit("previous");
          break;
        case "Seek":
          this.emit("seek", event.delta / TIME_RATIO);
          break;
        case "SetPosition":
          this.emit("setPosition", event.position / TIME_RATIO);
          break;
        case "SetVolume":
          this.emit("volume", event.volume);
          break;
      }
    });
  }

  onTrack(track: TrackInfo | null): void {
    this.metadata = track;
    this.artUrl = null;
    if (!track) {
      this.mediaSession.setMetadata(null);
      return;
    }
    // Send metadata right away; album art is attached once it has been
    // prefetched and cached locally (see refreshArtwork).
    this.pushMetadata();
    void this.refreshArtwork(track);
  }

  onStatus(status: PlaybackStatus): void {
    this.status = status;
    this.pushPlaybackState();
  }

  onPosition(position: number, seeked: boolean): void {
    this.position = position;
    this.pushPlaybackState();
    if (seeked) {
      this.mediaSession.sendSeeked(position * TIME_RATIO);
    }
  }

  onDuration(duration: number | null): void {
    this.duration = duration;
    this.pushMetadata();
  }

  onRate(rate: number): void {
    this.rate = rate;
    this.pushPlaybackState();
  }

  onVolume(volume: number): void {
    this.mediaSession.setVolume(volume);
  }

  dispose(): void {
    this.mediaSession.setMetadata(null);
    this.mediaSession.setEventHandler(null);
  }

  private pushMetadata(): void {
    if (!this.metadata) return;
    const metadata: MprisMetadata = {
      trackId: `/com/163/music/${this.metadata.id}`,
      title: this.metadata.title,
      artist: [this.metadata.artist],
      album: this.metadata.album,
      artUrl: this.artUrl || undefined,
      length: this.duration ? this.duration * TIME_RATIO : undefined,
    };
    this.mediaSession.setMetadata(metadata);
  }

  /**
   * Prefetch the album art with the global `got` client and cache it at
   * `${THUMBNAIL_CACHE_DIR}/${id}.<ext>`, then push the local `file://` URL as
   * `mpris:artUrl`. Falls back to the remote URL if the download fails.
   */
  private async refreshArtwork(track: TrackInfo): Promise<void> {
    const artUrl = await this.prefetchArtwork(track);
    if (this.metadata?.id !== track.id) return; // track changed meanwhile
    this.artUrl = artUrl;
    this.pushMetadata();
  }

  private async prefetchArtwork(track: TrackInfo): Promise<string> {
    // TODO: Local music's support
    if (!track.url) return ""; // no artwork URL

    // Fetch a reasonably-sized thumbnail instead of the original (potentially
    // huge) image — MPRIS clients only ever display a small square.
    const downloadUrl = resizedArtUrl(track.url);

    const filePath = join(
      THUMBNAIL_CACHE_DIR,
      `${track.id}${artworkExt(downloadUrl)}`
    );
    const fileUrl = pathToFileURL(filePath).toString();

    // Reuse the cached file if the art for this track was already downloaded.
    try {
      await stat(filePath);
      return fileUrl;
    } catch {
      // Not cached yet — download it.
    }

    try {
      await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
      const response = await client.get(downloadUrl, {
        responseType: "buffer",
      });
      await writeFile(filePath, response.body);
      await this.pruneThumbnails();
      return fileUrl;
    } catch {
      // Download failed; keep the (resized) remote URL so artwork still works.
      return downloadUrl;
    }
  }

  /**
   * Evict the oldest files so the thumbnail cache stays bounded at
   * `MAX_THUMBNAILS`. Called after each new thumbnail is written; the freshly
   * written file is the most recent and is always kept.
   */
  private async pruneThumbnails(): Promise<void> {
    try {
      const entries = await readdir(THUMBNAIL_CACHE_DIR, {
        withFileTypes: true,
      });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile())
          .map(async (e) => {
            const { mtimeMs } = await stat(join(THUMBNAIL_CACHE_DIR, e.name));
            return { name: e.name, mtimeMs };
          })
      );
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const stale = files.slice(0, Math.max(0, files.length - MAX_THUMBNAILS));
      await Promise.all(
        stale.map((f) => unlink(join(THUMBNAIL_CACHE_DIR, f.name)))
      );
    } catch {
      // Ignore pruning failures — the cache just grows until next time.
    }
  }

  private pushPlaybackState(): void {
    if (this.position === null) return;
    this.mediaSession.updatePlaybackState({
      status: toDbusStatus(this.status),
      position: this.position * TIME_RATIO,
      speed: this.rate,
    });
  }
}

/**
 * Art URL resized to a square thumbnail suitable for media controls. Falls
 * back to the original URL if it isn't a usable CDN URL.
 */
function resizedArtUrl(url: string): string {
  try {
    return imageSize(url, ARTWORK_SIZE);
  } catch {
    return url;
  }
}

/** Extension from a remote artwork URL, defaulting to `.jpg`. */
function artworkExt(url: string): string {
  try {
    return extname(new URL(url).pathname) || ".jpg";
  } catch {
    return ".jpg";
  }
}

function toDbusStatus(status: PlaybackStatus): DbusPlaybackStatus {
  switch (status) {
    case PlaybackStatus.Playing:
      return DbusPlaybackStatus.Playing;
    case PlaybackStatus.Paused:
      return DbusPlaybackStatus.Paused;
    case PlaybackStatus.Stopped:
      return DbusPlaybackStatus.Stopped;
  }
}
