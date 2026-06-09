import { ipcRenderer } from "electron";
import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState } from "./Player";
import { toError } from "../util";

export const PLAYING_EVENTS = ["play", "playing"];
export const HALTED_EVENTS = ["pause", "stalled", "ended", "error"];

export const player = new Player();

ipcRenderer.invoke("audio.getDevice").then((deviceId) => {
  if (deviceId && typeof deviceId === "string") {
    (player.audioContext as unknown as HTMLAudioElement)
      .setSinkId(deviceId)
      .catch((e) => {
        LOGGER.error({ err: toError(e) }, `Failed to set audio output device`);
      });
  }
});

let buffering = false;
let bufferProgress = 0;

function notifyBuffering(isBuffering: boolean) {
  if (buffering !== isBuffering) {
    buffering = isBuffering;
    fireNativeCall(
      "audioplayer.onBuffering",
      player.currentId,
      buffering ? 1 : 0
    );
  }
}

player.on("playinfoupdate", async (event) => {
  // Playback's stopped, it's replacing, tell main process
  ipcRenderer.send("player.timeupdate", null);
  await ipcRenderer.invoke("audio.updatePlayInfo", event.data);
});

player.on("load", (event) => {
  // Playback's ready, tell main process.
  ipcRenderer.send("player.timeupdate", 0);
  const { id } = event.data;
  bufferProgress = 0;
  fireNativeCall("audioplayer.onLoad", id, {
    activeCode: 0,
    code: 0,
    duration: player.audio.duration || 0,
    errorCode: 0,
    errorString: "",
    openWholeCached: true,
    preloadWholeCached: false,
  });
});

player.audio.addEventListener("play", () => {
  // 1806160891_1B5MK7|resume|XEDKE2
  // 1806160891|pause|4RB6IY
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Playing
  );
});

player.audio.addEventListener("pause", () => {
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Paused
  );
});

player.audio.addEventListener("ended", () => {
  fireNativeCall("audioplayer.onEnd", player.currentId, {
    activeCode: 0,
    code: 0,
    errorCode: 0,
    errorString: "",
    playedAudioTime: player.audio.duration * 1000 || 0,
    playedTime: player.audio.duration * 1000 || 0,
  });
});

player.audio.addEventListener("error", async (e) => {
  const id = player.currentId;
  const playInfo = player.currentPlayInfo;
  try {
    if (playInfo?.type === 4) {
      const [res] = await ipcRenderer.invoke("channel.call", "network.fetch", {
        url: playInfo.musicurl,
        method: "HEAD",
        retryCount: 3,
      });
      if (player.currentId !== id) return; // Check if the current audio has changed
      if (res.status === 403) {
        fireNativeCall("audioplayer.onrequestrefreshsongurl", playInfo);
      } else {
        // Not because of the expired link
        throw e.error;
      }
    }
  } catch {
    if (player.currentId !== id) return; // Check if the current audio has changed
    fireNativeCall("audioplayer.onEnd", id, {
      activeCode: 6,
      code: 2,
      errorCode: 3,
      errorString: "",
      playedAudioTime: player.audio.currentTime * 1000 || 0,
      playedTime: player.audio.currentTime * 1000 || 0,
    });
  }
});

player.audio.addEventListener("seeked", () => {
  fireNativeCall(
    "audioplayer.onSeek",
    player.currentId,
    "",
    0,
    player.audio.currentTime
  );
  notifyBuffering(true);
});

player.audio.addEventListener("stalled", () => {
  notifyBuffering(true);
});

player.audio.addEventListener("playing", () => {
  notifyBuffering(false);
});

const onPlayProgress = () => {
  fireNativeCall(
    "audioplayer.onPlayProgress",
    player.currentId,
    player.audio.currentTime,
    bufferProgress
  );
};
// NCM expects onPlayProgress to be called as fast as possible during playback
let rafId: number | null = null;
function startProgressRaf() {
  if (rafId !== null) return;
  const loop = () => {
    onPlayProgress();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function stopProgressRaf() {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}
PLAYING_EVENTS.forEach((e) =>
  player.audio.addEventListener(e, startProgressRaf)
);
HALTED_EVENTS.forEach((e) => player.audio.addEventListener(e, stopProgressRaf));
ipcRenderer.on("audio.onProgress", (event, progress) => {
  bufferProgress = progress;
  onPlayProgress();
});

player.on("volumechange", (event) => {
  fireNativeCall("audioplayer.onVolume", player.currentId, "", 0, event.data);
  ipcRenderer.send("player.volumechange", event.data);
});

player.on("audiodata", (event) => {
  const { data, pts } = event.data;
  fireNativeCall("audioplayer.onAudioData", { data, pts });
});

player.audio.addEventListener("ratechange", () => {
  ipcRenderer.send("player.playbackratechange", player.audio.playbackRate);
});

const PLAYBACK_CHANGE = {
  PLAYING: "playing",
  PAUSED: "paused",
  STOPPED: "stopped",
  STALLED: "stalled",
  SEEKING: "seeking",
} as const;

// Single playback-transition channel for the main process. `stalled` and
// `seeking` are transient: media-session status keeps its previous value, while
// lyrics still learns progress stopped via the controller's derived boolean.
PLAYING_EVENTS.forEach((e) =>
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.PLAYING);
  })
);
["pause"].forEach((e) =>
  player.audio.addEventListener(e, () => {
    ipcRenderer.send(
      "player.playbackchange",
      player.currentPlayInfo ? PLAYBACK_CHANGE.PAUSED : PLAYBACK_CHANGE.STOPPED
    );
  })
);
["ended", "error"].forEach((e) =>
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.STOPPED);
  })
);
["stalled"].forEach((e) =>
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.STALLED);
  })
);
["seeking"].forEach((e) =>
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.SEEKING);
  })
);

player.audio.addEventListener("seeked", () =>
  ipcRenderer.send("player.seeked", player.audio.currentTime)
);
player.audio.addEventListener("timeupdate", () =>
  ipcRenderer.send("player.timeupdate", player.audio.currentTime)
);
player.audio.addEventListener("durationchange", () => {
  let duration: number | null = player.audio.duration;
  if (!isFinite(duration) || duration < 0) duration = null;
  ipcRenderer.send("player.durationchange", duration);
});

ipcRenderer.on("player.seek", (e, delta) => {
  player.audio.currentTime += delta;
});

ipcRenderer.on("player.seekto", (e, position) => {
  player.audio.currentTime = position;
});

ipcRenderer.on("player.volume", (e, volume) => {
  player.volume = volume;
});
