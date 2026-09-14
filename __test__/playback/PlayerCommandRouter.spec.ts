import Emittery from "emittery";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerCommandEvents } from "../../src/main/playback/adapters/MediaSessionAdapter";
import PlaybackController from "../../src/main/playback/PlaybackController";
import PlayerCommandRouter from "../../src/main/playback/PlayerCommandRouter";
import { PlaybackChange, PlaybackStatus } from "../../src/main/playback/types";

// `../window` pulls in Electron; the router only needs `webContents.send`.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../src/main/window", () => ({
  mainWindow: { webContents: { send } },
}));

const track = { id: "1", title: "title", artist: "artist", album: "album" };

/** A controller in `status`, retaining a track unless `retained` is false. */
function controllerAt(
  status: PlaybackStatus,
  retained = true
): PlaybackController {
  const player = new PlaybackController();
  if (retained) player.setTrack(track);
  if (status === PlaybackStatus.Playing) {
    player.applyPlaybackChange(PlaybackChange.Playing);
  } else if (status === PlaybackStatus.Paused) {
    player.applyPlaybackChange(PlaybackChange.Paused);
  }
  return player;
}

function setup(status: PlaybackStatus, retained = true) {
  const player = controllerAt(status, retained);
  const commands = new Emittery<PlayerCommandEvents>();
  new PlayerCommandRouter(commands, player);
  return { player, commands };
}

const expectToggle = () =>
  expect(send).toHaveBeenCalledWith(
    "channel.call",
    "winhelper.onHotkey",
    "play_pause_3",
    true
  );

beforeEach(() => {
  send.mockClear();
});

describe("PlayerCommandRouter playback translation", () => {
  it("toggles once for `play` while paused", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
    expectToggle();
  });

  it("does not toggle for `pause` while paused", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("pause");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not toggle for `play` while playing", async () => {
    const { commands } = setup(PlaybackStatus.Playing);
    await commands.emit("play");
    expect(send).not.toHaveBeenCalled();
  });

  it("revives a retained track when `play` arrives while stopped", async () => {
    const { commands } = setup(PlaybackStatus.Stopped, true);
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
    expectToggle();
  });

  it("ignores `play` while stopped without a track", async () => {
    const { commands } = setup(PlaybackStatus.Stopped, false);
    await commands.emit("play");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not toggle for `pause` while stopped", async () => {
    const { commands } = setup(PlaybackStatus.Stopped);
    await commands.emit("pause");
    expect(send).not.toHaveBeenCalled();
  });

  it("coalesces repeated `play`s until the renderer confirms", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    await commands.emit("play");
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops a repeat once the renderer confirms playback", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    player.applyPlaybackChange(PlaybackChange.Playing); // renderer confirmation
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honours `pause` after playback is confirmed", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    player.applyPlaybackChange(PlaybackChange.Playing);
    await commands.emit("pause");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps a queued `pause` while the earlier `play` confirms", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play"); // toggle #1 → expects Playing
    await commands.emit("pause"); // toggle #2 → expects Paused
    player.applyPlaybackChange(PlaybackChange.Playing); // toggle #1 lands
    await commands.emit("pause"); // must not queue a third (cancelling) toggle
    expect(send).toHaveBeenCalledTimes(2);
    player.applyPlaybackChange(PlaybackChange.Paused); // toggle #2 lands
    await commands.emit("play"); // now a real transition is needed again
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("resyncs when a transition matches nothing in flight", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play"); // one toggle in flight → expects Playing
    // The renderer reports a status we never asked for (the song ended rather
    // than resuming): trust the report and forget the backlog.
    player.applyPlaybackChange(PlaybackChange.Stopped);
    await commands.emit("play"); // retained track ⇒ revivable again
    expect(send).toHaveBeenCalledTimes(2);
  });
});
