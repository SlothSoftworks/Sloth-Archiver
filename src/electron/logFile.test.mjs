import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactHomeDir, createRotatingLogWriter } from './logFile.mjs';

describe('redactHomeDir (SEC-016)', () => {
  it('replaces every occurrence of a POSIX home directory with ~', () => {
    const text = 'ERROR: unable to open /home/alice/Videos/a.mp4 (copied from /home/alice/Downloads/a.mp4)';
    expect(redactHomeDir(text, '/home/alice', 'linux')).toBe('ERROR: unable to open ~/Videos/a.mp4 (copied from ~/Downloads/a.mp4)');
  });

  it('does not touch a sibling directory that merely starts with the same name', () => {
    expect(redactHomeDir('/home/alice2/a.mp4 /home/alice/b.mp4 /home/alice', '/home/alice', 'linux')).toBe('/home/alice2/a.mp4 ~/b.mp4 ~');
    expect(redactHomeDir('C:\\Users\\Carol2\\a C:\\Users\\Carol\\b', 'C:\\Users\\Carol', 'win32')).toBe('C:\\Users\\Carol2\\a ~\\b');
  });

  it('ignores a trailing separator on the home directory', () => {
    expect(redactHomeDir('/Users/bob/Movies/x.mkv', '/Users/bob/', 'darwin')).toBe('~/Movies/x.mkv');
  });

  it('matches Windows paths case-insensitively and with either separator', () => {
    const home = 'C:\\Users\\Carol';
    const text = 'C:\\Users\\Carol\\Videos\\a.mp4 and c:/users/carol/Downloads/b.mp4';
    expect(redactHomeDir(text, home, 'win32')).toBe('~\\Videos\\a.mp4 and ~/Downloads/b.mp4');
  });

  it('leaves text alone when the home directory is a bare root or missing', () => {
    expect(redactHomeDir('/etc/hosts', '/', 'linux')).toBe('/etc/hosts');
    expect(redactHomeDir('C:\\x', 'C:\\', 'win32')).toBe('C:\\x');
    expect(redactHomeDir('/home/x', '', 'linux')).toBe('/home/x');
  });

  it('passes non-string values through unchanged', () => {
    expect(redactHomeDir(undefined, '/home/alice', 'linux')).toBeUndefined();
  });
});

describe('createRotatingLogWriter (SEC-016)', () => {
  let dir;
  let logPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloth-archiver-test-log-'));
    logPath = path.join(dir, 'main.log');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines to the log file', () => {
    const write = createRotatingLogWriter(logPath, 1000);
    write('one');
    write('two');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('one\ntwo\n');
  });

  it('moves the file to .1 once the next line would pass the cap, keeping only one old file', () => {
    const write = createRotatingLogWriter(logPath, 10);
    write('aaaa'); // 5 bytes
    write('bbbb'); // 10 bytes -- still fits
    write('cccc'); // would be 15 -> rotate first
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('aaaa\nbbbb\n');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('cccc\n');
    write('dddd');
    write('eeee'); // rotates again, replacing the old .1
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('cccc\ndddd\n');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('eeee\n');
    expect(fs.readdirSync(dir).sort()).toEqual(['main.log', 'main.log.1']);
  });

  it('still writes a single line larger than the cap rather than dropping it', () => {
    const write = createRotatingLogWriter(logPath, 4);
    write('longer than four');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('longer than four\n');
  });

  it('never throws when the log location is unwritable', () => {
    const write = createRotatingLogWriter(path.join(dir, 'missing-dir', 'main.log'), 1000);
    expect(() => write('x')).not.toThrow();
  });
});
