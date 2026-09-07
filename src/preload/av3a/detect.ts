import { ipcRenderer } from "electron";

/**
 * Ask main whether a local file is AV3A-encoded. Local play info does not
 * signal the codec (unlike URL play info's `audioFormat`), so the file must be
 * sniffed in main (which owns `fs`).
 */
export function isAv3aLocalFile(path: string): Promise<boolean> {
  return ipcRenderer.invoke("audio.isAv3aFile", path) as Promise<boolean>;
}
