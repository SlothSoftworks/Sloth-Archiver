import type { LiveStreamInfo } from '../types/electron-api';

// How far ahead of the playhead the stream is read before it waits, and how
// much already-played video is kept for seeking back. Together they bound
// memory: a 2-hour film never sits in the buffer whole.
const BUFFER_AHEAD_SECONDS = 30;
const BUFFER_BEHIND_SECONDS = 30;
// Played video is trimmed in slices this long, not on every chunk.
const EVICT_SLACK_SECONDS = 10;
// A seek this far past what the running stream has delivered is reached by
// that stream soon enough, so it isn't restarted.
const STREAM_REACH_SECONDS = 5;
const POLL_MS = 250;

type Range = { start: number; end: number };
type Stream = { start: number; abort: AbortController; done: boolean };

function rangeAt(ranges: TimeRanges, time: number): Range | null {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time && time <= ranges.end(i)) return { start: ranges.start(i), end: ranges.end(i) };
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Plays a live conversion (livePlayback.mjs, main): hand `mediaSource` to the
// player as its source and attach() the <video> element once it exists.
// Main's stream is fragmented MP4 carrying the source's own timestamps, so a
// run started mid-file lands where it belongs on the timeline. A seek to a
// time the running stream won't reach drops it and starts a new run there
// (or at the end of whatever is already buffered around that time). onError
// fires at most once, for a stream that fails or data the browser refuses.
export class LiveTranscodeSource {
  readonly mediaSource = new MediaSource();
  readonly #info: LiveStreamInfo;
  readonly #onError: () => void;
  #video: HTMLVideoElement | null = null;
  #sourceBuffer: SourceBuffer | null = null;
  #stream: Stream | null = null;
  #failed = false;
  #destroyed = false;

  constructor(info: LiveStreamInfo, onError: () => void) {
    this.#info = info;
    this.#onError = onError;
    this.mediaSource.addEventListener('sourceopen', this.#handleSourceOpen, { once: true });
  }

  attach(video: HTMLVideoElement) {
    if (this.#video === video) return;
    this.#detach();
    this.#video = video;
    video.addEventListener('seeking', this.#handleSeek);
    video.addEventListener('waiting', this.#handleSeek);
  }

  destroy() {
    this.#destroyed = true;
    this.#stream?.abort.abort();
    this.#stream = null;
    this.#detach();
  }

  #detach() {
    this.#video?.removeEventListener('seeking', this.#handleSeek);
    this.#video?.removeEventListener('waiting', this.#handleSeek);
    this.#video = null;
  }

  #handleSourceOpen = () => {
    if (this.#destroyed) return;
    if (this.#info.duration > 0) this.mediaSource.duration = this.#info.duration;
    try {
      this.#sourceBuffer = this.mediaSource.addSourceBuffer(this.#info.mimeType);
    } catch {
      this.#fail();
      return;
    }
    this.#startStream(this.#video?.currentTime ?? 0);
  };

  #handleSeek = () => {
    if (!this.#sourceBuffer || !this.#video || this.#destroyed) return;
    const time = this.#video.currentTime;
    if (this.#streamReaches(time)) return;
    const buffered = rangeAt(this.#sourceBuffer.buffered, time);
    if (buffered && buffered.end >= this.mediaSource.duration - 0.5) return;
    this.#startStream(buffered ? buffered.end : time);
  };

  // The span the running stream has delivered, plus what it's about to.
  #streamReaches(time: number) {
    const stream = this.#stream;
    if (!stream || !this.#sourceBuffer) return false;
    const delivered = rangeAt(this.#sourceBuffer.buffered, stream.start);
    const from = delivered ? delivered.start : stream.start;
    const to = (delivered ? delivered.end : stream.start) + (stream.done ? 0 : STREAM_REACH_SECONDS);
    return time >= from && time <= to;
  }

  #fail() {
    if (this.#failed || this.#destroyed) return;
    this.#failed = true;
    this.#stream?.abort.abort();
    this.#onError();
  }

  #isCurrent(stream: Stream) {
    return this.#stream === stream && !this.#destroyed && this.mediaSource.readyState !== 'closed';
  }

  async #startStream(start: number) {
    const previous = this.#stream;
    previous?.abort.abort();
    const stream: Stream = { start, abort: new AbortController(), done: false };
    this.#stream = stream;
    try {
      await this.#whenIdle();
      if (!this.#isCurrent(stream)) return;
      // Drops the half-read fragment the previous run may have left behind.
      if (previous && this.mediaSource.readyState === 'open') this.#sourceBuffer!.abort();
      const response = await fetch(`${this.#info.url}?start=${start.toFixed(3)}`, { signal: stream.abort.signal });
      if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status})`);
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (!this.#isCurrent(stream)) return;
        if (done) break;
        await this.#append(value, stream);
        if (!this.#isCurrent(stream)) return;
      }
      stream.done = true;
      await this.#whenIdle();
      if (this.#isCurrent(stream) && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      if (this.#isCurrent(stream)) this.#fail();
    }
  }

  async #append(chunk: Uint8Array<ArrayBuffer>, stream: Stream) {
    while (this.#isCurrent(stream) && this.#bufferedAhead() > BUFFER_AHEAD_SECONDS) await sleep(POLL_MS);
    for (;;) {
      await this.#evictPlayed(stream, BUFFER_BEHIND_SECONDS, EVICT_SLACK_SECONDS);
      if (!this.#isCurrent(stream)) return;
      try {
        this.#sourceBuffer!.appendBuffer(chunk);
        await this.#whenIdle();
        return;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'QuotaExceededError')) throw err;
        // A high-bitrate file can fill the browser's buffer quota before
        // BUFFER_AHEAD_SECONDS: let playback catch up and retry.
        await this.#evictPlayed(stream, 1, 0);
        await sleep(POLL_MS);
      }
    }
  }

  #bufferedAhead() {
    const time = this.#video?.currentTime ?? 0;
    const range = rangeAt(this.#sourceBuffer!.buffered, time);
    return range ? range.end - time : 0;
  }

  async #evictPlayed(stream: Stream, keepSeconds: number, slackSeconds: number) {
    const sourceBuffer = this.#sourceBuffer!;
    const evictUntil = (this.#video?.currentTime ?? 0) - keepSeconds;
    if (!this.#isCurrent(stream) || sourceBuffer.buffered.length === 0 || sourceBuffer.buffered.start(0) >= evictUntil - slackSeconds) return;
    await this.#whenIdle();
    if (!this.#isCurrent(stream)) return;
    sourceBuffer.remove(0, evictUntil);
    await this.#whenIdle();
  }

  #whenIdle(): Promise<void> {
    const sourceBuffer = this.#sourceBuffer;
    if (!sourceBuffer?.updating) return Promise.resolve();
    return new Promise((resolve) => sourceBuffer.addEventListener('updateend', () => resolve(), { once: true }));
  }
}
