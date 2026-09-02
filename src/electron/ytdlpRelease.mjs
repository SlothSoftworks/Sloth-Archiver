import fs from 'fs';
import path from 'path';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// Zero third-party dependencies on purpose -- this module is imported both
// by updater.mjs (which runs inside the packaged app, where node_modules is
// deliberately not shipped, see copy-electron.mjs's own comment on that) and
// by scripts/fetch-ytdlp-bin.mjs (a plain pre-build Node script). Only Node
// built-ins, no PATH-resolved external tools (no shelling out to `tar`/`gpg`
// -- that's exactly the "resolved from PATH" pattern this module exists to
// stop doing for yt-dlp's own binary).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// yt-dlp's real signing key, fetched once by hand from
// https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/public.key and
// committed here -- never fetched over the network at verification time.
// Verifying a signature with a key pulled from the same channel the
// signature is supposed to be defending would defeat the entire point.
export const YTDLP_PUBLIC_KEY_ARMORED = fs.readFileSync(path.join(__dirname, 'ytdlp-public-key.asc'), 'utf-8');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Distinguishes "the downloaded release didn't match its own published
// checksum/signature" from every other failure mode in fetchAndVerifyRelease
// (network errors, timeouts, a malformed SHA2-256SUMS format) -- callers use
// this to tell the user the problem is with the external yt-dlp release
// itself, not with this app, without having to pattern-match error text.
export const YTDLP_VERIFICATION_ERROR_CODE = 'YTDLP_VERIFICATION_FAILED';

function verificationError(message) {
    const err = new Error(message);
    err.code = YTDLP_VERIFICATION_ERROR_CODE;
    return err;
}

// Same hang-safety shape as updater.mjs's own fetchJson/downloadFile (kept
// as independent copies here rather than imported -- this module has to
// keep working standalone while updater.mjs's old Python-based update path
// is still present alongside it, unrelated to it, until it's removed).
function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location, { timeoutMs }).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(`Failed to parse JSON from ${url}`));
                }
            });
        }).on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
    });
}

function downloadFile(url, destPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadFile(res.headers.location, destPath, { timeoutMs }).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Download from ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(() => resolve()));
            fileStream.on('error', reject);
        }).on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Download from ${url} timed out after ${Math.round(timeoutMs / 1000)}s of inactivity`));
        });
    });
}

function downloadText(url, opts) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'sloth-archiver' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                downloadText(res.headers.location, opts).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`Request to ${url} failed with status ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
    });
}

// yt-dlp's official onedir .zip assets, per platform/arch -- deliberately
// never the bare (non-.zip) onefile names. The bare `yt-dlp_macos`/
// `yt-dlp_linux`/`yt-dlp.exe` files are PyInstaller onefile builds that
// self-extract to a fresh temp directory on every single launch, which is
// exactly the regression this project already hit once and reverted from
// when it previously tried fetching yt-dlp's own binary this same way. The
// .zip variants unpack to the same --onedir layout (a launcher plus an
// _internal/ folder) this project's own build already produces -- extracted
// once, not per launch.
// Also deliberately never `yt-dlp` (the Unix zipimport binary) or
// `yt-dlp_x86` (32-bit Windows) -- yt-dlp's own docs confirm curl_cffi
// (browser-impersonation, required outright for Dailymotion and used
// unconditionally by Instagram/TikTok) is bundled in every build except
// those two.
export function mapPlatformToAssetName({ platform = process.platform, arch = process.arch, isMusl = false } = {}) {
    if (platform === 'darwin') {
        // One universal2 build covers both Apple Silicon and Intel.
        return 'yt-dlp_macos.zip';
    }
    if (platform === 'win32') {
        if (arch === 'arm64') return 'yt-dlp_win_arm64.zip';
        if (arch === 'ia32') return 'yt-dlp_win_x86.zip';
        if (arch === 'x64') return 'yt-dlp_win.zip';
        throw new Error(`Unsupported Windows architecture: ${arch}`);
    }
    if (platform === 'linux') {
        if (arch === 'arm64') return isMusl ? 'yt-dlp_musllinux_aarch64.zip' : 'yt-dlp_linux_aarch64.zip';
        if (arch === 'x64') return isMusl ? 'yt-dlp_musllinux.zip' : 'yt-dlp_linux.zip';
        throw new Error(`Unsupported Linux architecture: ${arch}`);
    }
    throw new Error(`Unsupported platform: ${platform}`);
}

// Best-effort libc probe. Node's own diagnostic reporting populates
// glibcVersionRuntime only on a real glibc host -- its absence on Linux
// implies musl (e.g. Alpine), but this is a heuristic, not authoritative;
// callers can always override via mapPlatformToAssetName's own isMusl param.
export function detectMusl() {
    if (process.platform !== 'linux') return false;
    try {
        const header = process.report?.getReport?.()?.header;
        return !header || header.glibcVersionRuntime === undefined;
    } catch {
        return false;
    }
}

// With `pin`, resolves to that exact tag with no network call -- what the
// build script uses for a reproducible, pinned SlothArchiver release. Without
// it, resolves yt-dlp's real latest GitHub release once. Callers must call
// this exactly once per operation and thread the single result through every
// subsequent step (the asset URL, the SHA2-256SUMS URL, the .sig URL) --
// resolving "latest" more than once per operation is what let the old
// PyPI-vs-pip-install approach drift to two different versions mid-update.
export async function resolveLatestRelease({ pin } = {}) {
    if (pin) {
        return { tag: pin };
    }
    const release = await fetchJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
    return { tag: release.tag_name, assets: release.assets };
}

function assetDownloadUrl(tag, assetName) {
    return `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${assetName}`;
}

// --- Minimal OpenPGP-subset verification -----------------------------------
// Scoped to exactly what yt-dlp's own release signing actually uses --
// confirmed by hand-decoding their real key and a real release signature:
// an old-format RSA public-key packet (tag 6) and an old-format v4 RSA
// signature packet (tag 2, binary-document type 0x00, SHA-256 or SHA-512).
// Nothing else is supported -- DSA/EdDSA/ECDSA, new-format packet headers,
// v3 signatures, text-mode signatures are all deliberately rejected rather
// than silently handled some other way. All real cryptography (hashing, RSA
// verification) is delegated entirely to Node's built-in `crypto`; only
// fixed-format binary parsing of two small packets is hand-rolled.

function readOldFormatPacket(buf, offset) {
    if (offset >= buf.length) throw new Error('Truncated OpenPGP packet');
    const first = buf[offset];
    if ((first & 0x80) === 0) throw new Error('Not an OpenPGP packet');
    if ((first & 0x40) !== 0) throw new Error('New-format OpenPGP packets are not supported');
    const tag = (first >> 2) & 0x0f;
    const lengthType = first & 0x03;
    let pos = offset + 1;
    let length;
    if (lengthType === 0) { length = buf[pos]; pos += 1; }
    else if (lengthType === 1) { length = buf.readUInt16BE(pos); pos += 2; }
    else if (lengthType === 2) { length = buf.readUInt32BE(pos); pos += 4; }
    else throw new Error('Indeterminate-length OpenPGP packets are not supported');
    if (pos + length > buf.length) throw new Error('Truncated OpenPGP packet body');
    return { tag, body: buf.subarray(pos, pos + length), nextOffset: pos + length };
}

function readMpi(buf, offset) {
    if (offset + 2 > buf.length) throw new Error('Truncated OpenPGP MPI');
    const bitLen = buf.readUInt16BE(offset);
    const byteLen = Math.ceil(bitLen / 8);
    if (offset + 2 + byteLen > buf.length) throw new Error('Truncated OpenPGP MPI data');
    return { data: buf.subarray(offset + 2, offset + 2 + byteLen), nextOffset: offset + 2 + byteLen };
}

function parsePublicKeyPacketBody(body) {
    if (body.length < 6) throw new Error('Truncated OpenPGP public-key packet');
    if (body[0] !== 4) throw new Error('Only v4 OpenPGP public keys are supported');
    if (body[5] !== 1) throw new Error('Only RSA OpenPGP public keys are supported');
    const n = readMpi(body, 6);
    const e = readMpi(body, n.nextOffset);
    return { n: n.data, e: e.data };
}

function parseSignaturePacketBody(body) {
    if (body.length < 6) throw new Error('Truncated OpenPGP signature packet');
    if (body[0] !== 4) throw new Error('Only v4 OpenPGP signatures are supported');
    const sigType = body[1];
    if (body[2] !== 1) throw new Error('Only RSA OpenPGP signatures are supported');
    const hashAlgo = body[3];
    const hashedLen = body.readUInt16BE(4);
    if (6 + hashedLen > body.length) throw new Error('Truncated OpenPGP hashed subpacket data');
    let pos = 6 + hashedLen;
    if (pos + 2 > body.length) throw new Error('Truncated OpenPGP unhashed subpacket length');
    const unhashedLen = body.readUInt16BE(pos);
    pos += 2 + unhashedLen;
    // Two-byte "left 16 bits of the signed hash" quick-check field -- not
    // itself verified, just skipped over to reach the actual signature MPI.
    pos += 2;
    const mpi = readMpi(body, pos);
    return {
        sigType,
        hashAlgo,
        // The exact byte range RFC 4880 5.2.4 defines as covered by the
        // signature: version..hashed-subpacket-data, with its own header.
        hashedPortion: body.subarray(0, 6 + hashedLen),
        signatureMpi: mpi.data,
    };
}

function hashAlgoToNodeName(hashAlgo) {
    if (hashAlgo === 8) return 'sha256';
    if (hashAlgo === 10) return 'sha512';
    throw new Error(`Unsupported OpenPGP hash algorithm ${hashAlgo}`);
}

function parseArmoredPublicKey(armored) {
    const lines = armored.split('\n');
    let started = false;
    const bodyLines = [];
    for (const line of lines) {
        if (line.startsWith('-----BEGIN')) { started = true; continue; }
        if (line.startsWith('-----END')) break;
        if (!started) continue;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('=')) continue; // blank lines, header lines, CRC24 checksum
        bodyLines.push(trimmed);
    }
    if (!bodyLines.length) throw new Error('No OpenPGP public key data found in armored block');
    return Buffer.from(bodyLines.join(''), 'base64');
}

function base64Url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Verifies `signature` (a raw, non-armored, detached OpenPGP signature
// packet -- exactly the shape of a downloaded `SHA2-256SUMS.sig`) is a valid
// signature over `data`, made by the RSA key in `publicKeyArmored`. Returns
// a boolean; never returns true on anything it can't fully parse and
// validate -- a parse failure throws (treated as "not verified" by every
// caller here), never silently resolves to a pass.
export function verifyDetachedSignature({ data, signature, publicKeyArmored }) {
    const keyBuf = parseArmoredPublicKey(publicKeyArmored);
    const keyPacket = readOldFormatPacket(keyBuf, 0);
    if (keyPacket.tag !== 6) throw new Error('Expected an OpenPGP public-key packet');
    const { n, e } = parsePublicKeyPacketBody(keyPacket.body);

    const sigPacket = readOldFormatPacket(signature, 0);
    if (sigPacket.tag !== 2) throw new Error('Expected an OpenPGP signature packet');
    const { sigType, hashAlgo, hashedPortion, signatureMpi } = parseSignaturePacketBody(sigPacket.body);
    if (sigType !== 0x00) throw new Error('Expected a binary-document OpenPGP signature');

    // The v4 signature trailer: a fixed 0x04 0xFF marker, then the
    // hashed-portion length as a big-endian uint32.
    const trailer = Buffer.from([0x04, 0xff, 0, 0, 0, 0]);
    trailer.writeUInt32BE(hashedPortion.length, 2);
    const dataToVerify = Buffer.concat([data, hashedPortion, trailer]);

    const publicKey = crypto.createPublicKey({
        key: { kty: 'RSA', n: base64Url(n), e: base64Url(e) },
        format: 'jwk',
    });

    return crypto.verify(
        hashAlgoToNodeName(hashAlgo),
        dataToVerify,
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signatureMpi,
    );
}

// --- Minimal ZIP reader ------------------------------------------------------
// Scoped to exactly what a GitHub-Releases-hosted, PyInstaller-onedir build
// actually produces: single-disk, under 100MB, "stored" (0) or "deflate" (8)
// compression only, no encryption. Confirmed directly against the real
// yt-dlp_macos.zip asset that these official builds contain zero symlinks
// (unlike this project's own local PyInstaller onedir output, which needs
// dereferencing) -- so no symlink handling here on purpose; if a future
// yt-dlp release ever changes that, extraction will fail loudly (an
// unhandled entry type) rather than silently mis-copy a symlink as a file.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
// The EOCD record is fixed-size (22 bytes) plus a variable-length comment
// (max 65535 bytes) -- search backward from the end for its signature,
// bounded so a corrupt/non-zip file fails fast instead of scanning forever.
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

function findEndOfCentralDirectory(buf) {
    const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
    for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
    }
    throw new Error('Not a valid ZIP file: end-of-central-directory record not found');
}

export function unzip(zipPath, destDir) {
    const buf = fs.readFileSync(zipPath);
    const eocdOffset = findEndOfCentralDirectory(buf);
    const entryCount = buf.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

    let pos = centralDirOffset;
    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
            throw new Error(`Corrupt ZIP central directory at entry ${i}`);
        }
        const versionMadeBy = buf.readUInt16LE(pos + 4);
        const compressionMethod = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const externalAttrs = buf.readUInt32LE(pos + 38);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;

        // Reject path traversal in the entry name outright -- a malicious or
        // corrupt archive could otherwise write outside destDir.
        const destPath = path.join(destDir, name);
        if (path.relative(destDir, destPath).startsWith('..')) {
            throw new Error(`ZIP entry escapes destination directory: ${name}`);
        }

        if (name.endsWith('/')) {
            fs.mkdirSync(destPath, { recursive: true });
            continue;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        // Local file header's own name/extra-field lengths can differ from
        // the central directory's (rare in practice, but the format allows
        // it) -- read them fresh rather than assuming the central directory's
        // values apply to the local header's layout too.
        const lh = localHeaderOffset;
        if (buf.readUInt32LE(lh) !== LOCAL_FILE_SIGNATURE) {
            throw new Error(`Corrupt ZIP local file header for ${name}`);
        }
        const lhNameLen = buf.readUInt16LE(lh + 26);
        const lhExtraLen = buf.readUInt16LE(lh + 28);
        const dataStart = lh + 30 + lhNameLen + lhExtraLen;
        const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

        let fileData;
        if (compressionMethod === 0) {
            fileData = compressedData;
        } else if (compressionMethod === 8) {
            fileData = zlib.inflateRawSync(compressedData);
        } else {
            throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
        }
        if (fileData.length !== uncompressedSize) {
            throw new Error(`Size mismatch extracting ${name}: expected ${uncompressedSize}, got ${fileData.length}`);
        }
        fs.writeFileSync(destPath, fileData);

        // External attributes' upper 16 bits are the Unix mode when the
        // archive was made on a Unix host (version-made-by's high byte 3) --
        // restore it so the launcher executable comes out executable.
        const hostOs = versionMadeBy >> 8;
        if (hostOs === 3) {
            const unixMode = (externalAttrs >>> 16) & 0o7777;
            if (unixMode) {
                try {
                    fs.chmodSync(destPath, unixMode);
                } catch {
                    // Best-effort -- explicit chmod of the launcher below
                    // covers the one file that actually needs +x.
                }
            }
        }
    }
}

// Parses a `SHA2-256SUMS`-formatted string (`<hex digest>  <filename>` per
// line) and returns the hex digest for one specific filename, or null if
// that filename has no line.
export function findChecksumForAsset(sumsText, assetName) {
    for (const line of sumsText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = /^([0-9a-fA-F]+)\s+\*?(.+)$/.exec(trimmed);
        if (match && match[2] === assetName) return match[1].toLowerCase();
    }
    return null;
}

// The orchestration entry point: downloads assetName plus SHA2-256SUMS and
// SHA2-256SUMS.sig from `release` (as returned by resolveLatestRelease),
// verifies the asset's SHA-256 against its line in SHA2-256SUMS, verifies
// SHA2-256SUMS's own signature against the vendored public key, and only on
// full success unzips the asset into a fresh subdirectory of workDir.
//
// Fails closed on purpose, unlike yt-dlp's own `-U` (which proceeds with an
// unverified download if SHA2-256SUMS is simply unavailable) -- any missing
// asset, missing checksum line, missing/invalid signature, or hash mismatch
// throws immediately and nothing gets extracted.
export async function fetchAndVerifyRelease({ release, assetName, workDir, publicKeyArmored = YTDLP_PUBLIC_KEY_ARMORED, onProgress, onLog }) {
    fs.mkdirSync(workDir, { recursive: true });
    const assetPath = path.join(workDir, assetName);

    onProgress?.('fetching');
    onLog?.(`[ytdlp-release] downloading ${assetName} (${release.tag})`);
    await downloadFile(assetDownloadUrl(release.tag, assetName), assetPath);

    // TEMPORARY manual test hook -- flips one byte of the just-downloaded
    // asset so the checksum step below is exercised against real tampered
    // data, proving the fail-closed path actually rejects and refuses to
    // install rather than just being untested code. Inert unless the env var
    // is set. Revert this block once the manual test is done.
    if (process.env.SLOTH_DEBUG_TAMPER_YTDLP) {
        const tampered = fs.readFileSync(assetPath);
        tampered[0] ^= 0xff;
        fs.writeFileSync(assetPath, tampered);
        onLog?.('[ytdlp-release] TEST: tampered with downloaded asset on purpose');
    }

    onLog?.('[ytdlp-release] downloading SHA2-256SUMS and SHA2-256SUMS.sig');
    const [sumsText, sigBase64OrBinary] = await Promise.all([
        downloadText(assetDownloadUrl(release.tag, 'SHA2-256SUMS')),
        new Promise((resolve, reject) => {
            const sigPath = path.join(workDir, 'SHA2-256SUMS.sig');
            downloadFile(assetDownloadUrl(release.tag, 'SHA2-256SUMS.sig'), sigPath)
                .then(() => resolve(fs.readFileSync(sigPath)))
                .catch(reject);
        }),
    ]);

    onProgress?.('verifying');
    const expectedChecksum = findChecksumForAsset(sumsText, assetName);
    if (!expectedChecksum) {
        throw verificationError(`SHA2-256SUMS has no entry for ${assetName} -- refusing to install an unverified binary`);
    }

    const sumsBuffer = Buffer.from(sumsText, 'utf-8');
    let signatureValid;
    try {
        signatureValid = verifyDetachedSignature({ data: sumsBuffer, signature: sigBase64OrBinary, publicKeyArmored });
    } catch (err) {
        throw verificationError(`Failed to verify SHA2-256SUMS's signature: ${err.message}`);
    }
    if (!signatureValid) {
        throw verificationError("SHA2-256SUMS's GPG signature is invalid -- refusing to install an unverified binary");
    }
    onLog?.('[ytdlp-release] SHA2-256SUMS signature verified');

    const actualChecksum = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
    if (actualChecksum !== expectedChecksum) {
        throw verificationError(`Checksum mismatch for ${assetName}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }
    onLog?.(`[ytdlp-release] ${assetName} checksum verified`);

    onProgress?.('installing');
    const extractDir = path.join(workDir, 'extracted');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    unzip(assetPath, extractDir);

    // yt-dlp's own onedir assets name the launcher after the asset itself
    // (e.g. yt-dlp_macos.zip's launcher is literally called `yt-dlp_macos`,
    // confirmed against the real asset), not the fixed `yt-dlp`/`yt-dlp.exe`
    // name every spawn call site in this app expects (main.mjs's
    // ytdlpBinaryName). Rename it into place here, once, so every caller of
    // fetchAndVerifyRelease gets a directory shaped exactly like this
    // project's own previous local PyInstaller build already was.
    renameLauncherToCanonicalName(extractDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

    return extractDir;
}

// The onedir layout is always exactly one launcher executable plus one
// `_internal/` directory at the top level (confirmed against the real
// yt-dlp_macos.zip asset: 162 entries total, but exactly 2 at the top
// level). Finds that one launcher -- whatever it's actually named -- and
// renames it to `canonicalName`, rather than guessing a naming pattern per
// asset variant. Throws if the directory doesn't have exactly that shape,
// so a future change to yt-dlp's own packaging fails loudly here instead of
// silently shipping a binary at the wrong path.
export function renameLauncherToCanonicalName(dir, canonicalName) {
    const entries = fs.readdirSync(dir).filter((name) => name !== '_internal');
    if (entries.length !== 1) {
        throw new Error(`Expected exactly one launcher executable alongside _internal/ in ${dir}, found: ${entries.join(', ') || '(none)'}`);
    }
    const [launcherName] = entries;
    if (launcherName === canonicalName) return;
    fs.renameSync(path.join(dir, launcherName), path.join(dir, canonicalName));
}
