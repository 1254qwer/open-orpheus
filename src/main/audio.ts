import path, { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { Protocol } from "electron";
import mime from "mime";

import { OnlineStreamer } from "./audio/OnlineStreamer";
import { Av3aPcmStreamer, openAv3aFile } from "./audio/Av3aPcmStreamer";
import type { AudioPlayInfo } from "../preload/Player";
import { mainWindow } from "./window";
import { playCacheManager } from "./cache";
import { normalizePath, sanitizeRelativePath } from "./util";
import { data as dataDir, pack as packageDir } from "./folders";
import { events as lifecycleEvents } from "./lifecycle";
import { kv as settings } from "./settings";
import { toError } from "../util";
import { decodeNcae } from "./ncae";
import { parseRequestRange, RangeNotSatisfiableError } from "./audio/Range";

enum AudioType {
  Local,
  URL,
}

type CurrentAudioState = {
  playInfo: AudioPlayInfo;
} & (
  | {
      type: AudioType.Local;
      path: string;
      /**
       * Set on the first request once we have looked at the file.
       *
       * Local play info carries no format field and the play cache stores tracks
       * extensionless, so AV3A can only be detected by reading the bytes. That
       * happens here, lazily, rather than in `updatePlayInfo`: keeping that
       * handler synchronous means there is never a window where a request
       * arrives before `state` is set. Resolves to null for everything else,
       * which is then served straight from disk as before.
       */
      av3a?: Promise<Av3aPcmStreamer | null>;
    }
  | {
      type: AudioType.URL;
      streamer: OnlineStreamer | Av3aPcmStreamer;
    }
);
let state: CurrentAudioState | null = null;

function isAv3aPlayInfo(playInfo: AudioPlayInfo) {
  return playInfo.type === 4 && playInfo.audioFormat === "av3a";
}

function sendProgress(prog: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("audio.onProgress", prog);
}

export async function readEffect(pathInfo: { path: string; pathtype: number }) {
  if (pathInfo.pathtype !== 2) {
    throw new Error(
      "Unsupported audio.readEffect pathtype: " + pathInfo.pathtype
    );
  }
  const path = sanitizeRelativePath(dataDir, pathInfo.path);
  if (path === false) {
    throw new Error("Illegal path: " + pathInfo.path);
  }
  if (pathInfo.path.endsWith(".ncae")) {
    try {
      const content = await readFile(path);
      const ncae = await decodeNcae(content);
      return ncae;
    } catch (err) {
      throw new Error("Failed to load NCAE", {
        cause: err,
      });
    }
  }
  return await readFile(path, {
    encoding: "utf-8",
  });
}

export default function registerAudioStreamerScheme(protocol: Protocol) {
  protocol.handle("audio", async (request) => {
    const requestUrl = new URL(request.url);

    switch (requestUrl.hostname) {
      case "worklet": {
        const workletPath = path.join(
          import.meta.dirname,
          "worklets",
          path.normalize(requestUrl.pathname)
        );
        try {
          const isWasm = workletPath.endsWith(".wasm");
          const content = await readFile(workletPath, isWasm ? null : "utf-8");
          return new Response(content, {
            status: 200,
            headers: {
              "Content-Type": isWasm
                ? "application/wasm"
                : "application/javascript",
            },
          });
        } catch (e) {
          LOGGER.debug(
            { scheme: "audio", path: workletPath },
            "Failed to get worklet: %s",
            e
          );
          return new Response("Failed to load worklet", { status: 500 });
        }
      }
      case "audio": {
        if (!state) return new Response("No play info yet", { status: 400 });

        if (state.type === AudioType.Local) {
          const local = state;
          local.av3a ??= openAv3aFile(local.path);
          const av3a = await local.av3a;
          if (state !== local) {
            return new Response("Audio state has changed", { status: 410 });
          }
          if (av3a) {
            // Every byte is already on disk, so there is no download to report.
            sendProgress(1);
            return av3a.handleRequest(request);
          }

          const path = local.path;
          const fileStat = await stat(path);
          const fileSize = fileStat.size;
          const mimeType = mime.getType(path) || "application/octet-stream";

          sendProgress(1);

          const rangeHeader = request.headers.get("Range");
          if (rangeHeader) {
            try {
              const { start, end } = parseRequestRange(rangeHeader, fileSize);
              const nodeStream = createReadStream(path, {
                start,
                end: end - 1,
              });

              return new Response(Readable.toWeb(nodeStream), {
                status: 206,
                headers: {
                  "Content-Type": mimeType,
                  "Content-Length": String(end - start),
                  "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`,
                  "Accept-Ranges": "bytes",
                },
              });
            } catch (error) {
              if (!(error instanceof RangeNotSatisfiableError)) throw error;
            }
            // Invalid or unsatisfiable range — return 416
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: {
                "Accept-Ranges": "bytes",
                "Content-Range": `bytes */${fileSize}`,
              },
            });
          }

          const nodeStream = createReadStream(path);

          return new Response(Readable.toWeb(nodeStream), {
            status: 200,
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(fileSize),
              "Accept-Ranges": "bytes",
            },
          });
        } else if (state.type === AudioType.URL) {
          return state.streamer.handleRequest(request);
        }
        return new Response("Unknown play info state", { status: 500 });
      }
      case "resource": {
        const type = mime.getType(requestUrl.pathname);
        if (!type?.startsWith("audio/"))
          return new Response("Unsupported resource", { status: 400 });

        const fullPath = sanitizeRelativePath(
          join(packageDir, "resource"),
          requestUrl.pathname
        );
        if (fullPath === false)
          return new Response("Not Found", { status: 404 });

        try {
          const content = await readFile(fullPath);
          return new Response(content, {
            headers: {
              "Content-Type": type,
            },
          });
        } catch (err) {
          return new Response(toError(err).message, { status: 500 });
        }
      }
    }
    return new Response("Not Found", { status: 404 });
  });
}

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;
  mainWindow.webContents.ipc.handle("audio.setDevice", async (e, deviceId) => {
    return settings.set("audio.currentDevice", deviceId);
  });

  mainWindow.webContents.ipc.handle("audio.getDevice", async () => {
    return settings.get("audio.currentDevice");
  });

  mainWindow.webContents.ipc.handle(
    "audio.readEffect",
    async (
      event,
      pathInfo: {
        pathtype: number;
        path: string;
      }
    ) => {
      try {
        return await readEffect(pathInfo);
      } catch (err) {
        LOGGER.error(
          { err: toError(err), pathInfo },
          `Failed to read audio effect`
        );
        return null;
      }
    }
  );

  mainWindow.webContents.ipc.handle(
    "audio.updatePlayInfo",
    (event, playInfo: AudioPlayInfo | null) => {
      if (state?.type === AudioType.URL) {
        // We don't await this, let it destroy in background
        state.streamer.destroy().catch((e) => {
          LOGGER.error(
            { err: toError(e) },
            `Failed to destroy previous OnlineStreamer`
          );
        });
      } else if (state?.type === AudioType.Local) {
        state.av3a
          ?.then((av3a) => av3a?.destroy())
          .catch((e) => {
            LOGGER.error(
              { err: toError(e) },
              `Failed to destroy previous local AV3A session`
            );
          });
      }
      state = null;
      if (!playInfo) return;

      if (playInfo.type === 0) {
        // Local File Play
        playInfo.path = normalizePath(playInfo.path);
        state = {
          type: AudioType.Local,
          playInfo,
          path: playInfo.path,
        };
      } else if (playInfo.type === 4) {
        // URL Play
        const songId = playInfo.songId;
        const isAv3a = isAv3aPlayInfo(playInfo);
        const streamer = new OnlineStreamer(playInfo.musicurl, {
          // AV3A is decoded on demand by its wrapper; a full source prefetch
          // would duplicate the decoded PCM cache and defeat range playback.
          background: !isAv3a,
        });

        streamer.on("progress", (e) => {
          sendProgress(e.data.loaded / e.data.total);
        });

        if (!isAv3a) {
          streamer.on("complete", async () => {
            if (state?.playInfo.songId !== songId) return;
            try {
              const buf = await streamer.readBuffer();
              playCacheManager
                ?.cacheTrack(songId, buf, {
                  md5: playInfo.md5,
                  bitrate: playInfo.bitrate,
                  playInfoStr: playInfo.playInfoStr,
                  volumeGain: 0,
                  fileSize: buf.length,
                })
                .catch((err) => {
                  LOGGER.error({ err: toError(err) }, `Failed to cache track`);
                });
            } catch (e) {
              LOGGER.error({ err: toError(e) }, `Cannot get streamed track`);
            }
          });
        }

        streamer.on("error", (e) => {
          LOGGER.error({ err: e.data }, `OnlineStreamer errored`);
        });

        state = {
          type: AudioType.URL,
          playInfo,
          streamer: isAv3a ? new Av3aPcmStreamer(streamer) : streamer,
        };
      }
    }
  );
});
