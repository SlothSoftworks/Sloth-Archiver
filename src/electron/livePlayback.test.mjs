import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { canPlayLive, liveMimeType, buildLiveTranscodeArgs, createLivePlayback } from './livePlayback.mjs';

const HEVC_AC3 = [{ codecType: 'video', codecName: 'hevc' }, { codecType: 'audio', codecName: 'ac3' }];
const H264_DTS = [{ codecType: 'video', codecName: 'h264' }, { codecType: 'audio', codecName: 'dts' }];

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

function setup() {
  const procs = [];
  const spawn = vi.fn(() => {
    const proc = fakeProcess();
    procs.push(proc);
    return proc;
  });
  const onLog = vi.fn();
  const live = createLivePlayback({ ffmpegBinaryPath: '/bin/ffmpeg', onLog, spawn });
  return { live, spawn, procs, onLog };
}

const request = (url) => new Request(url);

describe('canPlayLive', () => {
  it('needs video Chromium decodes from a stream copy', () => {
    expect(canPlayLive(H264_DTS, 'linux')).toBe(true);
    expect(canPlayLive([{ codecType: 'video', codecName: 'vp9' }], 'linux')).toBe(true);
    expect(canPlayLive([{ codecType: 'video', codecName: 'av1' }], 'linux')).toBe(true);
    expect(canPlayLive([{ codecType: 'video', codecName: 'mpeg4' }], 'linux')).toBe(false);
    expect(canPlayLive([{ codecType: 'audio', codecName: 'ac3' }], 'linux')).toBe(false);
  });

  it('takes HEVC only on macOS', () => {
    expect(canPlayLive(HEVC_AC3, 'darwin')).toBe(true);
    expect(canPlayLive(HEVC_AC3, 'win32')).toBe(false);
  });
});

describe('liveMimeType', () => {
  it('names the video codec family, plus AAC when there is audio', () => {
    expect(liveMimeType(HEVC_AC3, 'darwin')).toBe('video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"');
    expect(liveMimeType([{ codecType: 'video', codecName: 'h264' }], 'linux')).toBe('video/mp4; codecs="avc1.640028"');
  });
});

describe('buildLiveTranscodeArgs', () => {
  it('copies the video, converts the first audio track, and keeps the source timestamps', () => {
    const args = buildLiveTranscodeArgs({ filePath: '/m/a.mkv', startSeconds: 0, streams: H264_DTS });
    expect(args).not.toContain('-ss');
    expect(args.join(' ')).toContain('-copyts -start_at_zero -i /m/a.mkv -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -ac 2 -f mp4');
    expect(args).toContain('frag_keyframe+empty_moov+default_base_moof+delay_moov+frag_discont');
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('seeks before the input, and tags HEVC the way MediaSource expects', () => {
    const args = buildLiveTranscodeArgs({ filePath: '/m/a.mkv', startSeconds: 600.5, streams: HEVC_AC3 });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '600.500']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args.join(' ')).toContain('-c:v copy -tag:v hvc1');
  });
});

describe('createLivePlayback', () => {
  it('refuses a token it never handed out', async () => {
    const { live, spawn } = setup();
    const response = live.handleRequest(request('app-live://stream/nope?start=0'));
    expect(response.status).toBe(404);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('streams ffmpeg\'s output for the registered file from the asked-for time', async () => {
    const { live, spawn, procs } = setup();
    const token = live.register('/m/a.mkv', H264_DTS);

    const response = live.handleRequest(request(`app-live://stream/${token}?start=42.5`));
    const body = response.text();
    procs[0].stdout.write('fragment-1 ');
    procs[0].stdout.end('fragment-2');
    procs[0].emit('close', 0);

    expect(await body).toBe('fragment-1 fragment-2');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(spawn.mock.calls[0][0]).toBe('/bin/ffmpeg');
    expect(spawn.mock.calls[0][1]).toEqual(buildLiveTranscodeArgs({ filePath: '/m/a.mkv', startSeconds: 42.5, streams: H264_DTS }));
  });

  it('fails the stream, and logs why, when ffmpeg exits with an error', async () => {
    const { live, procs, onLog } = setup();
    const token = live.register('/m/a.mkv', H264_DTS);

    const body = live.handleRequest(request(`app-live://stream/${token}?start=0`)).text();
    procs[0].stderr.write('[matroska] Invalid data found when processing input\n');
    await new Promise((resolve) => setImmediate(resolve));
    procs[0].stdout.end();
    procs[0].emit('close', 1);

    await expect(body).rejects.toThrow();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('The source file appears to be corrupted or incomplete.'));
  });

  it('kills ffmpeg when the renderer drops the request, without logging a failure', async () => {
    const { live, procs, onLog } = setup();
    const token = live.register('/m/a.mkv', H264_DTS);

    const response = live.handleRequest(request(`app-live://stream/${token}?start=0`));
    await response.body.cancel();
    procs[0].emit('close', null);

    expect(procs[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(onLog).not.toHaveBeenCalled();
  });

  it('kills every running conversion on quit', () => {
    const { live, procs } = setup();
    const token = live.register('/m/a.mkv', H264_DTS);
    live.handleRequest(request(`app-live://stream/${token}?start=0`));
    live.handleRequest(request(`app-live://stream/${token}?start=300`));

    live.killAll();

    expect(procs.map((p) => p.kill.mock.calls.length)).toEqual([1, 1]);
  });
});
