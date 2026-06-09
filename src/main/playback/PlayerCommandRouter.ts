import Emittery from "emittery";

import { mainWindow } from "../window";
import { PlayerCommandEvents } from "./adapters/MediaSessionAdapter";

/**
 * Translates media-session commands (MPRIS / SMTC / MPNowPlayingInfo adapters)
 * into the renderer-facing IPC the preload already understands.
 *
 * This is the only place that maps abstract commands onto the two distinct
 * seek semantics the preload exposes: `player.seek` (relative delta) vs
 * `player.seekto` (absolute position).
 */
export default class PlayerCommandRouter {
  constructor(commands: Emittery<PlayerCommandEvents>) {
    commands.on("play", () => this.sendHotkey("play_pause_3"));
    commands.on("pause", () => this.sendHotkey("play_pause_3"));
    commands.on("next", () => this.sendHotkey("next_1"));
    commands.on("previous", () => this.sendHotkey("prev_1"));
    commands.on("seek", ({ data }) => this.send("player.seek", data));
    commands.on("setPosition", ({ data }) => this.send("player.seekto", data));
    commands.on("volume", ({ data }) => this.send("player.volume", data));
  }

  private send(channel: string, ...args: unknown[]): void {
    mainWindow?.webContents.send(channel, ...args);
  }

  private sendHotkey(name: string): void {
    mainWindow?.webContents.send(
      "channel.call",
      "winhelper.onHotkey",
      name,
      true
    );
  }
}
