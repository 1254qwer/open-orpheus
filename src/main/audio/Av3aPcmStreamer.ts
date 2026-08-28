import {
  Av3aRenderSession,
  indexAv3aMp4Moov,
  readAv3aMp4FirstSample,
  type Av3aMp4Index,
} from "@open-orpheus/avs3a-decoder";

import { open, stat, type FileHandle } from "node:fs/promises";

import { toError } from "../../util";

import { parseRequestRange, RangeNotSatisfiableError } from "./Range";

const WAV_HEADER_LENGTH = 44;
const OUTPUT_CHANNELS = 2;
const MAX_WAV_DATA_LENGTH = 0xffff_ffff - 36;
const DECODE_BATCH_FRAMES = 32;

const MP4_BOX_HEADER_BYTES = 8;
const MP4_LARGE_SIZE_HEADER_BYTES = 16;
const MAX_TOP_LEVEL_BOXES = 1024;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
// Keep this in sync with avs3a-rust's bounded MP4 sample reader.
const MAX_MP4_SAMPLE_BYTES = 2 * (9 + 12_300);

/**
 * The byte source an AV3A session reads its MP4 from.
 *
 * `OnlineStreamer` satisfies this, and so does a plain local file, which is what
 * lets the same decode and render path serve a progressive download and an
 * already-cached track.
 *
 * The source owns its compressed bytes; this adapter only reads bounded ranges.
 */
interface Av3aSource {
  readonly totalLength: number;
  ensureRange(start: number, end: number, signal?: AbortSignal): Promise<void>;
  readBuffer(start: number, end: number): Promise<Buffer>;
  destroy(): Promise<void>;
}

/**
 * An {@link Av3aSource} backed by a file that is already on disk, so a cached or
 * user-supplied track goes through the same decode and render path as a download.
 */
export class LocalFileSource implements Av3aSource {
  private constructor(
    private handle: FileHandle | null,
    readonly totalLength: number
  ) {}

  static async open(path: string): Promise<LocalFileSource> {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new Error("AV3A source is not a regular file: " + path);
    }
    return new LocalFileSource(await open(path, "r"), info.size);
  }

  // Already local; nothing to fetch.
  async ensureRange() {}

  async readBuffer(start: number, end: number): Promise<Buffer> {
    if (!this.handle) throw new Error("AV3A local source is closed");
    const length = end - start;
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await this.handle.read(
        buffer,
        read,
        length - read,
        start + read
      );
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read !== length) {
      throw new Error(
        `AV3A local source read ${read} of ${length} bytes at ${start}`
      );
    }
    return buffer;
  }

  /** Closes our handle. Never touches the file itself — we do not own it. */
  async destroy() {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }
}

async function indexSource(source: Av3aSource): Promise<Av3aMp4Index> {
  // Online sources learn their length while preparing their first range.  An
  // empty ensure is enough to await that metadata without downloading data.
  await source.ensureRange(0, 0);
  const moov = await readTopLevelMoov(source);
  const first = readAv3aMp4FirstSample(moov);

  const firstStart = checkedInteger(first.offset, "AV3A first sample offset");
  const firstSize = checkedSampleSize(first.size);
  const firstEnd = checkedEnd(firstStart, firstSize, "AV3A first sample");
  await source.ensureRange(firstStart, firstEnd);
  const firstSample = await source.readBuffer(firstStart, firstEnd);
  if (firstSample.byteLength !== firstEnd - firstStart) {
    throw new Error("AV3A first sample was not completely downloaded");
  }
  const index = indexAv3aMp4Moov(moov, firstSample);
  for (const sample of index.samples) {
    const offset = checkedInteger(sample.offset, "AV3A sample offset");
    const size = checkedSampleSize(sample.size);
    const end = checkedEnd(offset, size, "AV3A sample");
    if (end > source.totalLength) {
      throw new Error("AV3A MP4 sample extends past the source");
    }
  }
  return index;
}

/** Locate and fetch only the top-level `moov` box. */
async function readTopLevelMoov(source: Av3aSource): Promise<Buffer> {
  if (!Number.isSafeInteger(source.totalLength) || source.totalLength < 8) {
    throw new Error("AV3A source is too short to be an MP4");
  }

  let offset = 0;
  for (
    let count = 0;
    count < MAX_TOP_LEVEL_BOXES && offset < source.totalLength;
    count += 1
  ) {
    const [end, type] = await readBoxHeader(source, offset);
    if (type === "moov") {
      if (end - offset > MAX_MOOV_BYTES) {
        throw new Error("AV3A MP4 moov box is too large");
      }
      await source.ensureRange(offset, end);
      const bytes = await source.readBuffer(offset, end);
      if (bytes.byteLength !== end - offset) {
        throw new Error("AV3A moov box was not completely downloaded");
      }
      return bytes;
    }
    if (end <= offset) break;
    offset = end;
  }
  throw new Error("AV3A MP4 has no top-level moov box");
}

async function readBoxHeader(
  source: Av3aSource,
  offset: number
): Promise<[number, string]> {
  const headerEnd = Math.min(
    source.totalLength,
    offset + MP4_LARGE_SIZE_HEADER_BYTES
  );
  await source.ensureRange(offset, headerEnd);
  const bytes = await source.readBuffer(offset, headerEnd);
  if (bytes.byteLength < MP4_BOX_HEADER_BYTES) {
    throw new Error("AV3A MP4 has a truncated box header");
  }

  const size32 = bytes.readUInt32BE(0);
  const type = bytes.toString("ascii", 4, 8);
  let headerSize = MP4_BOX_HEADER_BYTES;
  let size: number;
  if (size32 === 1) {
    if (bytes.byteLength < MP4_LARGE_SIZE_HEADER_BYTES) {
      throw new Error("AV3A MP4 has a truncated large box header");
    }
    const largeSize = bytes.readBigUInt64BE(8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "AV3A MP4 box is outside the JavaScript safe integer range"
      );
    }
    size = Number(largeSize);
    headerSize = MP4_LARGE_SIZE_HEADER_BYTES;
  } else if (size32 === 0) {
    size = source.totalLength - offset;
  } else {
    size = size32;
  }

  if (size < headerSize || !Number.isSafeInteger(size)) {
    throw new Error(`AV3A MP4 has an invalid ${type} box size`);
  }
  const end = checkedEnd(offset, size, `${type} box`);
  if (end > source.totalLength) {
    throw new Error(`AV3A MP4 ${type} box extends past the source`);
  }
  return [end, type];
}

function checkedInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is outside the JavaScript safe integer range`);
  }
  return value;
}

function checkedSampleSize(value: number) {
  const size = checkedInteger(value, "AV3A sample size");
  if (size <= 0 || size > MAX_MP4_SAMPLE_BYTES) {
    throw new Error(`AV3A sample size ${size} is out of range`);
  }
  return size;
}

function checkedEnd(start: number, size: number, name: string) {
  const safeStart = checkedInteger(start, `${name} start`);
  const safeSize = checkedInteger(size, `${name} size`);
  const end = safeStart + safeSize;
  if (!Number.isSafeInteger(end)) throw new Error(`${name} range overflows`);
  return end;
}

/** Probe a local file and retain the index so playback does not parse it twice. */
export async function openAv3aFile(path: string) {
  let source: LocalFileSource | undefined;
  try {
    source = await LocalFileSource.open(path);
    return new Av3aPcmStreamer(source, await indexSource(source));
  } catch {
    try {
      await source?.destroy();
    } catch {
      // The probe result is still "not AV3A" when cleanup fails.
    }
    return null;
  }
}

type Av3aMetadata = {
  index: Av3aMp4Index;
  /// Bytes of rendered PCM per AV3A frame.
  frameBytes: number;
  pcmLength: number;
  wavLength: number;
};

/** Owns one stateful decoder/render session and serializes range requests. */
class Av3aPlaybackSession {
  private readonly renderer = new Av3aRenderSession();
  private readonly abortController = new AbortController();
  private decodeQueue: Promise<void> = Promise.resolve();
  private nextSample = 0;
  private destroyed = false;

  constructor(
    private readonly source: Av3aSource,
    private readonly metadata: Av3aMetadata
  ) {}

  async read(start: number, end: number, signal: AbortSignal) {
    this.assertActive();
    if (end <= start) return Buffer.alloc(0);

    const firstFrame = Math.floor(start / this.metadata.frameBytes);
    const lastFrame = Math.ceil(end / this.metadata.frameBytes);
    const decoded = await this.enqueueDecode(
      firstFrame,
      lastFrame,
      AbortSignal.any([signal, this.abortController.signal])
    );
    const offset = start - firstFrame * this.metadata.frameBytes;
    return decoded.subarray(offset, offset + (end - start));
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController.abort(new Error("AV3A playback session destroyed"));
    await this.decodeQueue.catch(() => {});
    this.renderer.close();
  }

  private enqueueDecode(start: number, end: number, signal: AbortSignal) {
    const task = this.decodeQueue.then(
      () => this.ensureDecoded(start, end, signal),
      () => this.ensureDecoded(start, end, signal)
    );
    this.decodeQueue = task.then(
      () => {},
      () => {}
    );
    return task;
  }

  private async ensureDecoded(start: number, end: number, signal: AbortSignal) {
    this.assertActive();
    throwIfAborted(signal);
    start = Math.max(0, start);
    end = Math.min(this.metadata.index.samples.length, end);
    if (start >= end) return Buffer.alloc(0);

    // Reuse decoder state only when a request starts where the previous one
    // ended; every other position needs the codec warm-up frames.
    if (this.nextSample !== start) {
      this.restartAt(start);
    }

    const output: Buffer[] = [];
    let outputLength = 0;
    while (this.nextSample < end) {
      throwIfAborted(signal);
      const batchStart = this.nextSample;
      const batchEnd = this.findBatchEnd(batchStart, end);
      try {
        const pcm = await this.decodeSamples(batchStart, batchEnd, signal);
        throwIfAborted(signal);
        this.nextSample = batchEnd;

        const expectedBytes =
          (batchEnd - batchStart) * this.metadata.frameBytes;
        if (pcm.byteLength !== expectedBytes) {
          throw new Error(
            "AV3A renderer returned " +
              pcm.byteLength +
              " bytes, expected " +
              expectedBytes
          );
        }
        const outputStart = Math.max(batchStart, start);
        const outputEnd = Math.min(batchEnd, end);
        if (outputEnd > outputStart) {
          const chunk = pcm.subarray(
            (outputStart - batchStart) * this.metadata.frameBytes,
            (outputEnd - batchStart) * this.metadata.frameBytes
          );
          output.push(chunk);
          outputLength += chunk.byteLength;
        }
      } catch (error) {
        // A decoder may have consumed a batch before cancellation or a length
        // check failed. Reset its temporal state so the next request cannot
        // mistake that partial batch for a contiguous continuation.
        this.restartAt(start);
        throw error;
      }
    }

    return Buffer.concat(output, outputLength);
  }

  /**
   * Reposition the decoder for a discontinuous jump to `frame`.
   *
   * The `warmupFrames` before it are decoded but not written, so nothing with a
   * cold MDCT overlap or a cold limiter reaches the output. Measured on a 7.1.4
   * track, two frames is the knee: one leaves errors up to 2498 LSB, two settles
   * at ~150, and 4 through 128 are flat.
   *
   * That floor is the decoder, not the render — its noise stream is seeded once
   * and free-runs, so output depends on how many frames it has decoded. A seek
   * therefore changes the BWE-band noise realisation (~10 LSB mean, 150 peak)
   * rather than producing a level step. Raising `warmupFrames` only costs
   * latency.
   */
  private restartAt(frame: number) {
    this.renderer.reset();
    this.nextSample = Math.max(0, frame - this.metadata.index.warmupFrames);
  }

  private findBatchEnd(start: number, limit: number) {
    const samples = this.metadata.index.samples;
    const first = samples[start];
    if (!first) {
      throw new Error("AV3A MP4 index is missing sample " + start);
    }

    // Batch only across samples that are physically contiguous, so one range
    // read covers the whole batch.
    let end = start + 1;
    let sourceEnd = checkedEnd(
      first.offset,
      checkedSampleSize(first.size),
      "AV3A sample range"
    );
    const batchLimit = Math.min(limit, start + DECODE_BATCH_FRAMES);
    while (end < batchLimit) {
      const sample = samples[end];
      if (!sample || sample.offset !== sourceEnd) break;
      sourceEnd = checkedEnd(
        sourceEnd,
        checkedSampleSize(sample.size),
        "AV3A sample range"
      );
      end += 1;
    }
    return end;
  }

  private async decodeSamples(start: number, end: number, signal: AbortSignal) {
    const samples = this.metadata.index.samples;
    const first = samples[start];
    const last = samples[end - 1];
    if (!first || !last) {
      throw new Error(
        "AV3A MP4 index is missing samples in " + start + ".." + end
      );
    }
    const sampleSizes = samples
      .slice(start, end)
      .map((sample) => checkedSampleSize(sample.size));
    const lastSize = sampleSizes.at(-1);
    if (lastSize === undefined) {
      throw new Error("AV3A decode batch is empty");
    }
    const sourceEnd = checkedEnd(last.offset, lastSize, "AV3A sample range");
    await this.source.ensureRange(first.offset, sourceEnd, signal);
    throwIfAborted(signal);
    const packets = await this.source.readBuffer(first.offset, sourceEnd);
    if (packets.byteLength !== sourceEnd - first.offset) {
      throw new Error("AV3A MP4 samples were not completely downloaded");
    }
    return this.renderer.decode(packets, sampleSizes);
  }

  private assertActive() {
    if (this.destroyed) throw new Error("AV3A playback session is destroyed");
  }
}

export class Av3aPcmStreamer {
  private metadataPromise: Promise<Av3aMetadata> | null = null;
  private session: Av3aPlaybackSession | null = null;
  private destroyed = false;

  constructor(
    readonly source: Av3aSource,
    private readonly indexed?: Av3aMp4Index
  ) {}

  async handleRequest(request: Request) {
    // Captured for the 416 path, which has to report the resource size.
    let wavLength = 0;
    try {
      if (this.destroyed) {
        return new Response("AV3A PCM streamer has been destroyed", {
          status: 410,
        });
      }
      const metadata = await this.getMetadata();
      this.assertActive();
      wavLength = metadata.wavLength;
      const rangeHeader = request.headers.get("range");
      const isRangeRequest = rangeHeader !== null;
      const range = parseRequestRange(rangeHeader, metadata.wavLength);
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Content-Type": "audio/wav",
        "Content-Length": String(range.end - range.start),
      });
      if (isRangeRequest) {
        headers.set(
          "Content-Range",
          "bytes " +
            range.start +
            "-" +
            (range.end - 1) +
            "/" +
            metadata.wavLength
        );
      }

      return new Response(
        this.createBody(metadata, range.start, range.end, request.signal),
        {
          status: isRangeRequest ? 206 : 200,
          headers,
        }
      );
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": "bytes */" + wavLength,
          },
        });
      }
      const normalizedError = toError(error);
      LOGGER.error(
        { err: normalizedError, range: request.headers.get("range") },
        "AV3A audio request failed"
      );
      return new Response(normalizedError.message, { status: 500 });
    }
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const metadataPromise = this.metadataPromise;
    const session = this.session;
    try {
      // Destroy the source first so an in-flight metadata/range request is
      // actively aborted; waiting for metadata before doing so can hang on a
      // slow network.
      await this.source.destroy();
    } finally {
      await metadataPromise?.catch(() => {});
      await session?.destroy();
    }
  }

  private getMetadata() {
    if (!this.metadataPromise) this.metadataPromise = this.loadMetadata();
    return this.metadataPromise;
  }

  private getSession(metadata: Av3aMetadata) {
    this.assertActive();
    return (this.session ??= new Av3aPlaybackSession(this.source, metadata));
  }

  private async loadMetadata(): Promise<Av3aMetadata> {
    const index = await this.loadIndex();

    const frameBytes = OUTPUT_CHANNELS * index.samplesPerFrame * 2;
    // One output frame per input frame keeps the byte-to-frame mapping strictly
    // one-to-one.
    const pcmLength = index.samples.length * frameBytes;
    const wavLength = WAV_HEADER_LENGTH + pcmLength;
    if (
      !Number.isSafeInteger(frameBytes) ||
      frameBytes <= 0 ||
      !Number.isSafeInteger(pcmLength) ||
      pcmLength <= 0 ||
      pcmLength > MAX_WAV_DATA_LENGTH ||
      !Number.isSafeInteger(wavLength)
    ) {
      throw new Error("AV3A track size is out of range: " + pcmLength);
    }
    LOGGER.debug(
      {
        frames: index.samples.length,
        sampleRate: index.sampleRate,
      },
      "AV3A stream indexed"
    );
    return { index, frameBytes, pcmLength, wavLength };
  }

  private loadIndex() {
    return this.indexed
      ? Promise.resolve(this.indexed)
      : indexSource(this.source);
  }

  private assertActive() {
    if (this.destroyed) throw new Error("AV3A PCM streamer has been destroyed");
  }

  private createBody(
    metadata: Av3aMetadata,
    start: number,
    end: number,
    signal: AbortSignal
  ) {
    let cursor = start;
    const cancelController = new AbortController();
    const bodySignal = AbortSignal.any([signal, cancelController.signal]);

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (cursor >= end) {
          controller.close();
          return;
        }
        try {
          throwIfAborted(bodySignal);
          const next =
            cursor < WAV_HEADER_LENGTH
              ? Math.min(end, WAV_HEADER_LENGTH)
              : Math.min(
                  end,
                  WAV_HEADER_LENGTH +
                    (Math.floor(
                      (cursor - WAV_HEADER_LENGTH) / metadata.frameBytes
                    ) +
                      DECODE_BATCH_FRAMES) *
                      metadata.frameBytes
                );
          const chunk = await this.readChunk(
            metadata,
            cursor,
            next,
            bodySignal
          );
          if (chunk.byteLength === 0) {
            controller.close();
            return;
          }
          if (chunk.byteLength !== next - cursor) {
            throw new Error(
              `AV3A PCM read returned ${chunk.byteLength} of ${next - cursor} bytes`
            );
          }
          cursor += chunk.byteLength;
          controller.enqueue(chunk);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        cancelController.abort(reason);
      },
    });
  }

  private async readChunk(
    metadata: Av3aMetadata,
    start: number,
    end: number,
    signal: AbortSignal
  ) {
    if (start < WAV_HEADER_LENGTH) {
      const header = createWavHeader(
        OUTPUT_CHANNELS,
        metadata.index.sampleRate,
        metadata.pcmLength
      );
      return header.subarray(start, Math.min(end, WAV_HEADER_LENGTH));
    }

    const session = await this.getSession(metadata);
    return session.read(
      start - WAV_HEADER_LENGTH,
      end - WAV_HEADER_LENGTH,
      signal
    );
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw toError(signal.reason ?? new Error("Audio request aborted"));
  }
}

function createWavHeader(
  channels: number,
  sampleRate: number,
  dataLength: number
) {
  if (
    !Number.isSafeInteger(channels) ||
    !Number.isSafeInteger(sampleRate) ||
    !Number.isSafeInteger(dataLength) ||
    channels <= 0 ||
    sampleRate <= 0 ||
    dataLength < 0 ||
    dataLength > MAX_WAV_DATA_LENGTH
  ) {
    throw new Error("AV3A WAV header values are out of range");
  }
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  if (
    blockAlign > 0xffff ||
    !Number.isSafeInteger(byteRate) ||
    byteRate > 0xffff_ffff ||
    sampleRate > 0xffff_ffff
  ) {
    throw new Error("AV3A WAV format is out of range");
  }
  const header = new Uint8Array(WAV_HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataLength, true);
  header.set([0x57, 0x41, 0x56, 0x45], 8);
  header.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  header.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataLength, true);
  return header;
}
