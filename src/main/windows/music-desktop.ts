import { join } from "node:path";
import os from "node:os";

import { LayerShellLayer, setWindowAsBackground } from "@open-orpheus/window";

import { ManagedWindow } from "../window";
import { isAppUrl } from "../util";

export default class MusicDesktopWindow extends ManagedWindow {
  constructor(url: string) {
    super();
    const wnd = this.createBrowserWindow({
      title: "Open Orpheus Music Desktop",
      frame: false,
      resizable: false,
      roundedCorners: false,
      hasShadow: false,
      skipTaskbar: true,
      movable: false,
      transparent: true,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, "preload.js"),
      },
    });
    if (isAppUrl(url)) {
      void wnd.loadURL(url);
    } else {
      LOGGER.warn(
        { url },
        `refused to load a non-application URL into the music desktop window`
      );
    }
    this.setWindowInputRegion([]);
    if (os.platform() === "win32" || os.platform() === "darwin")
      try {
        setWindowAsBackground(wnd.getNativeWindowHandle());
      } catch (e) {
        // Destroy the window and rethrow
        this.destroy();
        throw e;
      }
  }

  protected beforeSurfaceCreated(): void {
    this.setLayerShell({
      namespace: "Open Orpheus Music Desktop",
      layer: LayerShellLayer.Background,
      anchorBottom: true,
      anchorLeft: true,
      anchorRight: true,
      anchorTop: true,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      exclusiveZone: -1,
    });
  }
}
