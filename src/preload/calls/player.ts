import { registerCallHandler } from "../calls";

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", () => {
  return;
});

registerCallHandler<[number], [boolean]>("player.setTotalTime", () => {
  return [true];
});
