import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
    ERROR_KINDS,
    classifyDownloadError,
    isAutoRetryable,
    getBackoffMs,
    RETRY_BACKOFF_MS,
    recheckDiskSpaceIfAmbiguous,
} from './downloadErrors.mjs';

describe('classifyDownloadError', () => {
    it('classifies a spawn ENOENT as missingDependency', () => {
        const result = classifyDownloadError({ spawnError: { code: 'ENOENT', message: 'spawn yt-dlp ENOENT' } });
        expect(result.kind).toBe(ERROR_KINDS.MISSING_DEPENDENCY);
    });

    it('classifies an unrecognized spawn error as unknown', () => {
        const result = classifyDownloadError({ spawnError: { code: 'EACCES', message: 'permission denied' } });
        expect(result.kind).toBe(ERROR_KINDS.UNKNOWN);
    });

    it('classifies a bot-check message as botBlock', () => {
        const result = classifyDownloadError({ stderr: 'ERROR: [youtube] abc123: Sign in to confirm you\'re not a bot', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.BOT_BLOCK);
    });

    it('classifies HTTP 429 as rateLimit', () => {
        const result = classifyDownloadError({ stderr: 'ERROR: unable to download video data: HTTP Error 429: Too Many Requests', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.RATE_LIMIT);
    });

    it('classifies a real private-video message as unavailable (reused from videoInfo.mjs)', () => {
        const result = classifyDownloadError({ stderr: 'ERROR: [youtube] abc123: Private video. Sign in if you\'ve been granted access to this video', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.UNAVAILABLE);
    });

    it('classifies a fragment failure as chunkTransferFailure', () => {
        const result = classifyDownloadError({ stderr: 'ERROR: fragment 3 not found, unable to continue', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.CHUNK_TRANSFER_FAILURE);
    });

    it('classifies a disk-full message as outOfDiskSpace', () => {
        const result = classifyDownloadError({ stderr: 'ERROR: unable to write data: [Errno 28] No space left on device', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.OUT_OF_DISK_SPACE);
    });

    it('falls back to unknown for an unrecognized message and extracts the last ERROR: line', () => {
        const result = classifyDownloadError({ stderr: 'some noise\nERROR: something totally unrecognized happened', exitCode: 1 });
        expect(result.kind).toBe(ERROR_KINDS.UNKNOWN);
        expect(result.message).toBe('something totally unrecognized happened');
    });
});

describe('isAutoRetryable', () => {
    it('allows transient kinds', () => {
        expect(isAutoRetryable(ERROR_KINDS.NETWORK)).toBe(true);
        expect(isAutoRetryable(ERROR_KINDS.CHUNK_TRANSFER_FAILURE)).toBe(true);
        expect(isAutoRetryable(ERROR_KINDS.RATE_LIMIT)).toBe(true);
        expect(isAutoRetryable(ERROR_KINDS.STALLED)).toBe(true);
    });

    it('never allows a bot-block to auto-retry (retrying blind escalates a soft block)', () => {
        expect(isAutoRetryable(ERROR_KINDS.BOT_BLOCK)).toBe(false);
    });

    it('never allows permanent content-level blockers or disk-full to auto-retry', () => {
        expect(isAutoRetryable(ERROR_KINDS.OUT_OF_DISK_SPACE)).toBe(false);
        expect(isAutoRetryable(ERROR_KINDS.UNAVAILABLE)).toBe(false);
        expect(isAutoRetryable(ERROR_KINDS.AGE_RESTRICTED)).toBe(false);
    });
});

describe('getBackoffMs', () => {
    it('follows the fixed ladder and caps at the last step', () => {
        expect(getBackoffMs(0)).toBe(RETRY_BACKOFF_MS[0]);
        expect(getBackoffMs(3)).toBe(RETRY_BACKOFF_MS[3]);
        expect(getBackoffMs(10)).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
    });
});

describe('recheckDiskSpaceIfAmbiguous', () => {
    it('leaves a non-unknown kind untouched', async () => {
        const kind = await recheckDiskSpaceIfAmbiguous(ERROR_KINDS.NETWORK, path.join(os.tmpdir(), 'whatever.mp4'));
        expect(kind).toBe(ERROR_KINDS.NETWORK);
    });

    it('leaves unknown as unknown when the real disk has plenty of free space', async () => {
        const kind = await recheckDiskSpaceIfAmbiguous(ERROR_KINDS.UNKNOWN, path.join(os.tmpdir(), 'whatever.mp4'));
        expect(kind).toBe(ERROR_KINDS.UNKNOWN);
    });
});
