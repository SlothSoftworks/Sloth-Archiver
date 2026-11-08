import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveTranscodeSource } from './liveTranscodeSource';
import { FakeMediaSource, streamResponse } from './__fixtures__/fakeMediaSource';

const INFO = { url: 'app-live://stream/t1', mimeType: 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"', duration: 1273 };
const chunk = (n: number) => new Uint8Array([n]);

type FetchCall = { url: string; signal: AbortSignal };
let fetches: FetchCall[];
let respond: (call: FetchCall) => unknown;

function fakeVideo(currentTime = 0) {
  return Object.assign(new EventTarget(), { currentTime }) as unknown as HTMLVideoElement & { currentTime: number };
}

function setup(video = fakeVideo()) {
  const onError = vi.fn();
  const live = new LiveTranscodeSource(INFO, onError);
  live.attach(video);
  // SAFETY: the stubbed global constructor is FakeMediaSource.
  const mediaSource = live.mediaSource as unknown as FakeMediaSource;
  mediaSource.open();
  return { live, mediaSource, sourceBuffer: mediaSource.sourceBuffers[0], video, onError };
}

function seek(video: HTMLVideoElement & { currentTime: number }, time: number) {
  video.currentTime = time;
  video.dispatchEvent(new Event('seeking'));
}

beforeEach(() => {
  fetches = [];
  respond = () => streamResponse([chunk(1), chunk(2)]);
  vi.stubGlobal('MediaSource', FakeMediaSource);
  vi.stubGlobal('fetch', vi.fn((url: string, { signal }: { signal: AbortSignal }) => {
    const call = { url, signal };
    fetches.push(call);
    return Promise.resolve(respond(call));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LiveTranscodeSource', () => {
  it('streams from the start into a source buffer of the given type, then ends the stream', async () => {
    const { mediaSource, sourceBuffer } = setup();
    expect(mediaSource.duration).toBe(1273);
    expect(sourceBuffer.mimeType).toBe(INFO.mimeType);
    await vi.waitFor(() => expect(mediaSource.readyState).toBe('ended'));
    expect(fetches.map((f) => f.url)).toEqual(['app-live://stream/t1?start=0.000']);
    expect(sourceBuffer.appended).toEqual([chunk(1), chunk(2)]);
  });

  it('starts a new run at a seek the running stream won\'t reach', async () => {
    respond = ({ signal }) => streamResponse([chunk(1)], { end: false, signal });
    const { sourceBuffer, video } = setup();
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(1));
    sourceBuffer.ranges = [[0, 12]];

    seek(video, 600);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[0].signal.aborted).toBe(true);
    expect(fetches[1].url).toBe('app-live://stream/t1?start=600.000');
    expect(sourceBuffer.aborts).toBe(1);
  });

  it('keeps the running stream for a seek inside what it has delivered, or just past it', async () => {
    respond = ({ signal }) => streamResponse([chunk(1)], { end: false, signal });
    const { sourceBuffer, video } = setup();
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(1));
    sourceBuffer.ranges = [[0, 12]];

    seek(video, 8);
    seek(video, 15);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetches).toHaveLength(1);
  });

  it('continues from the end of an older buffered range a seek lands in', async () => {
    respond = ({ signal }) => streamResponse([chunk(1)], { end: false, signal });
    const { sourceBuffer, video } = setup(fakeVideo(600));
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(1));
    sourceBuffer.ranges = [[0, 40], [594, 630]];

    seek(video, 20);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[1].url).toBe('app-live://stream/t1?start=40.000');
  });

  it('restarts when playback stalls somewhere the stream isn\'t heading', async () => {
    respond = ({ signal }) => streamResponse([chunk(1)], { end: false, signal });
    const { sourceBuffer, video } = setup();
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(1));
    sourceBuffer.ranges = [[0, 12]];

    video.currentTime = 300;
    video.dispatchEvent(new Event('waiting'));
    await vi.waitFor(() => expect(fetches[1]?.url).toBe('app-live://stream/t1?start=300.000'));
  });

  it('stops reading while far enough ahead of the playhead', async () => {
    const { sourceBuffer, video } = setup();
    sourceBuffer.ranges = [[0, 45]];
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sourceBuffer.appended).toHaveLength(0);

    video.currentTime = 20;
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(2));
  });

  it('trims video played long ago before appending more', async () => {
    const { sourceBuffer, video } = setup(fakeVideo(100));
    sourceBuffer.ranges = [[0, 110]];
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(2));
    expect(sourceBuffer.removed[0]).toEqual([0, 70]);
    expect(video.currentTime).toBe(100);
  });

  it('reports a stream main couldn\'t start, once', async () => {
    respond = () => ({ ok: false, status: 404, body: null });
    const { onError, video } = setup();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    seek(video, 50);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops streaming once destroyed', async () => {
    respond = ({ signal }) => streamResponse([chunk(1)], { end: false, signal });
    const { live, sourceBuffer, video, onError } = setup();
    await vi.waitFor(() => expect(sourceBuffer.appended).toHaveLength(1));
    live.destroy();
    expect(fetches[0].signal.aborted).toBe(true);
    seek(video, 600);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetches).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
