import type { MakerSquirrelConfig } from "@electron-forge/maker-squirrel";
import type { MakerRpmConfig } from "@electron-forge/maker-rpm";
import type { MakerDebConfig } from "@electron-forge/maker-deb";
import type { MakerFlatpakConfig } from "@electron-forge/maker-flatpak";
import type { MakerAppImageConfigOptions } from "@reforged/maker-appimage";

export const squirrel: MakerSquirrelConfig = {
  name: "OpenOrpheus",
  title: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  authors: "YUCLing",
};

export const rpm: MakerRpmConfig["options"] = {
  icon: "assets/icon_256.png",
  name: "open-orpheus",
  productName: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  license: "MIT",
  homepage: "https://github.com/YUCLing/open-orpheus",
  categories: ["Audio", "AudioVideo", "Network"],
};

export const deb: MakerDebConfig["options"] = {
  icon: "assets/icon_256.png",
  name: "open-orpheus",
  productName: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  homepage: "https://github.com/YUCLing/open-orpheus",
  categories: ["Audio", "AudioVideo", "Network"],
};

export const flatpak: MakerFlatpakConfig["options"] = {
  id: "io.github.yucling.open-orpheus",
  productName: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  files: [
    [
      "assets/icon_256.png",
      "/share/icons/hicolor/256x256/apps/io.github.yucling.open-orpheus.png",
    ],
  ],
  icon: undefined,
  categories: ["AudioVideo", "Audio", "Network"],
  runtimeVersion: "25.08",
  baseVersion: "25.08",
  modules: [],
  finishArgs: [
    "--socket=wayland",
    "--socket=fallback-x11",
    "--share=ipc",
    "--device=dri",
    "--socket=pulseaudio",
    "--share=network",
    "--talk-name=org.kde.StatusNotifierWatcher",
  ],
};

export const AppImage: MakerAppImageConfigOptions = {
  name: "open-orpheus",
  productName: "Open Orpheus",
  icon: "assets/icon_256.png",
  categories: ["Audio", "AudioVideo", "Music", "Network"],
};
