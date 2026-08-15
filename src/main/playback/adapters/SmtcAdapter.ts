import Emittery from "emittery";

import { MediaSession } from "@open-orpheus/smtc";
import { PlaybackStatus, TrackInfo } from "../types";
import {
  MediaSessionAdapter,
  PlayerCommandEvents,
} from "./MediaSessionAdapter";
import { imageSize } from "../../../util";

// SMTC uses 100 ns ticks; we use seconds.
const TIME_RATIO = 10_000_000;

/** Windows SMTC integration, backed by the `@open-orpheus/smtc` NAPI module. */
export default class SmtcAdapter
  extends Emittery<PlayerCommandEvents>
  implements MediaSessionAdapter
{
  private mediaSession: MediaSession;

  private position: number | null = null;
  private duration: number | null = null;

  constructor() {
    super();
    this.mediaSession = new MediaSession();

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
        case "Stop":
          this.emit("pause");
          break;
        case "SetPosition":
          this.emit("setPosition", event.position / TIME_RATIO);
          break;
        case "SetRate":
          // OS-initiated rate change needs a renderer command; ignored in v1.
          break;
      }
    });
  }

  onTrack(track: TrackInfo | null): void {
    this.mediaSession.setMetadata(
      track
        ? {
            title: track.title,
            artist: track.artist,
            album: track.album,
            artUrl: imageSize(track.url, 512),
          }
        : null
    );
  }

  onStatus(status: PlaybackStatus): void {
    this.mediaSession.setPlaybackStatus(status);
    this.pushTimeline();
  }

  onPosition(position: number): void {
    this.position = position;
    this.pushTimeline();
  }

  onDuration(duration: number | null): void {
    this.duration = duration;
    this.pushTimeline();
  }

  onRate(rate: number): void {
    this.mediaSession.setPlaybackRate(rate);
  }

  onVolume(): void {
    // SMTC has no volume concept.
  }

  dispose(): void {
    this.mediaSession.setMetadata(null);
    this.mediaSession.setEventHandler(null);
  }

  private pushTimeline(): void {
    if (this.position === null) return;
    this.mediaSession.setTimelineProperties(
      Math.round(this.position * TIME_RATIO),
      Math.round((this.duration ?? 0) * TIME_RATIO)
    );
  }
}
