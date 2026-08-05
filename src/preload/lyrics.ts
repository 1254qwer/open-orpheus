import { ipcRenderer } from "electron";

import { HALTED_EVENTS, player, PLAYING_EVENTS } from "./audioplayer";

PLAYING_EVENTS.forEach((e) => {
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("lyrics.setPlayState", true);
  });
});
HALTED_EVENTS.forEach((e) => {
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("lyrics.setPlayState", false);
  });
});

player.audio.addEventListener("timeupdate", () => {
  ipcRenderer.send("lyrics.setTime", player.audio.currentTime);
});

player.audio.addEventListener("ratechange", () => {
  ipcRenderer.send("lyrics.setPlaybackRate", player.audio.playbackRate);
});
