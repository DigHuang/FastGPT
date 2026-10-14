import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { SANDBOX_ARCHIVE_MAX_ENTRIES } from '../../../core/ai/sandbox/constants';

export type TarEntryType = 'file' | 'directory' | 'symlink';

export type TarEntryInput = {
  path: string;
  type?: TarEntryType;
  content?: Buffer | string;
  linkname?: string;
  mode?: number;
  mtime?: Date | number;
};

export type ParsedTarEntry = {
  path: string;
  type: TarEntryType;
  size: number;
  mode: number;
  mtime: number;
  linkname?: string;
  content: Buffer;
};

export type ConvertZipEntryInspector = (params: {
  path: string;
  type: TarEntryType;
  size: number;
  readContent?: () => Promise<Buffer>;
}) => Promise<void> | void;

export type ConvertZipToTarGzOptions = {
  maxUncompressedBytes?: number;
  maxEntries?: number;
  gzipLevel?: number;
  onEntry?: ConvertZipEntryInspector;
};

const TAR_BLOCK_SIZE = 512;
const MAX_USTAR_OCTAL_SIZE = 0o77777777777; // 8 GiB - 1
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;
const S_IFBLK = 0o060000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

/** 判断 Buffer 是否以 GZIP 魔数 (0x1f 0x8b) 开头。 */
export const isGzipBuffer = (buffer: Buffer): boolean =>
  buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

/** 判断 Buffer 是否以 ZIP 魔数 (PK\x03\x04 / PK\x05\x06 / PK\x07\x08) 开头。 */
export const isZipBuffer = (buffer: Buffer): boolean =>
  buffer.length >= 4 &&
  buffer[0] === 0x50 &&
  buffer[1] === 0x4b &&
  (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);

/**
 * 归一化并校验归档内部相对路径，拦截空路径、NUL 字节、绝对路径与 `..` 路径穿越。
 */
export const normalizeArchiveEntryPath = (
  rawPath: string,
  options?: { allowTrailingSlash?: boolean }
): string => {
  if (rawPath.includes('\0')) {
    throw new Error('Invalid archive entry path: NUL byte is not allowed');
  }

  const slashNormalized = rawPath.replace(/\\/g, '/').trim();
  const isTrailingSlash = slashNormalized.endsWith('/');
  const strippedLeading = slashNormalized.replace(/^(?:\.\/)+/, '');

  if (strippedLeading.startsWith('/')) {
    throw new Error(`Invalid archive entry path (absolute path prohibited): ${rawPath}`);
  }

  const rawSegments = strippedLeading.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (rawSegments.length === 0) {
    return '';
  }

  for (const segment of rawSegments) {
    if (segment === '..') {
      throw new Error(`Invalid archive entry path (path traversal prohibited): ${rawPath}`);
    }
  }

  const normalized = rawSegments.join('/');
  if (options?.allowTrailingSlash && isTrailingSlash) {
    return `${normalized}/`;
  }
  return normalized;
};

/**
 * 校验归档内软链接目标是否安全：禁止绝对路径目标，禁止相对路径解析后逃逸出归档根目录。
 */
export const validateArchiveSymlinkTarget = (params: {
  entryPath: string;
  linkTarget: string;
}): void => {
  const { entryPath, linkTarget } = params;
  if (!linkTarget || linkTarget.includes('\0')) {
    throw new Error(`Invalid symlink target in archive entry: ${entryPath}`);
  }

  const normalizedTarget = linkTarget.replace(/\\/g, '/');
  if (normalizedTarget.startsWith('/')) {
    throw new Error(`Symlink target cannot be absolute path: ${entryPath} -> ${linkTarget}`);
  }

  const entryDir = path.posix.dirname(entryPath);
  const resolved = path.posix.normalize(
    entryDir === '.' ? normalizedTarget : `${entryDir}/${normalizedTarget}`
  );
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new Error(`Symlink target escapes archive root: ${entryPath} -> ${linkTarget}`);
  }
};

/**
 * 编码 POSIX USTAR + PAX 头部块（必要时自动前置 'x' PAX 扩展头）。
 */
const encodeTarHeader = (params: {
  path: string;
  type: TarEntryType;
  size: number;
  mode: number;
  mtimeSeconds: number;
  linkname?: string;
}): Buffer => {
  const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

  const writeOctal = (buf: Buffer, value: number, offset: number, length: number) => {
    const octal = Math.max(0, Math.floor(value))
      .toString(8)
      .padStart(length - 1, '0');
    buf.write(octal.slice(-(length - 1)), offset, length - 1, 'ascii');
    buf[offset + length - 1] = 0;
  };

  const buildUstarBlock = (blockParams: {
    name: string;
    typeflag: string;
    size: number;
    mode: number;
    mtimeSeconds: number;
    linkname: string;
  }): Buffer => {
    const block = Buffer.alloc(TAR_BLOCK_SIZE, 0);
    block.write(blockParams.name.slice(0, 100), 0, 100, 'utf8');
    writeOctal(block, blockParams.mode & 0o0777, 100, 8);
    writeOctal(block, 0, 108, 8); // uid = 0
    writeOctal(block, 0, 116, 8); // gid = 0
    writeOctal(block, Math.min(blockParams.size, MAX_USTAR_OCTAL_SIZE), 124, 12);
    writeOctal(block, blockParams.mtimeSeconds, 136, 12);
    block.fill(0x20, 148, 156); // chksum placeholder spaces
    block.write(blockParams.typeflag, 156, 1, 'ascii');
    if (blockParams.linkname) {
      block.write(blockParams.linkname.slice(0, 100), 157, 100, 'utf8');
    }
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    block.write('root', 265, 32, 'ascii');
    block.write('root', 297, 32, 'ascii');
    writeOctal(block, 0, 329, 8);
    writeOctal(block, 0, 337, 8);

    let checksum = 0;
    for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
      checksum += block[i];
    }
    const checksumOctal = checksum.toString(8).padStart(6, '0');
    block.write(checksumOctal, 148, 6, 'ascii');
    block[154] = 0;
    block[155] = 0x20;
    return block;
  };

  const buildPaxRecord = (key: string, value: string): Buffer => {
    const suffix = ` ${key}=${value}\n`;
    const suffixByteLength = Buffer.byteLength(suffix, 'utf8');
    let totalLength = suffixByteLength + String(suffixByteLength).length;
    while (String(totalLength).length + suffixByteLength !== totalLength) {
      totalLength = suffixByteLength + String(totalLength).length;
    }
    return Buffer.from(`${totalLength}${suffix}`, 'utf8');
  };

  const entryPath =
    params.type === 'directory' && !params.path.endsWith('/') ? `${params.path}/` : params.path;
  const linkname = params.linkname ?? '';
  const paxRecords: Buffer[] = [];

  if (Buffer.byteLength(entryPath, 'utf8') > 100 || !isAscii(entryPath)) {
    paxRecords.push(buildPaxRecord('path', entryPath));
  }
  if (linkname && (Buffer.byteLength(linkname, 'utf8') > 100 || !isAscii(linkname))) {
    paxRecords.push(buildPaxRecord('linkpath', linkname));
  }
  if (params.size > MAX_USTAR_OCTAL_SIZE) {
    paxRecords.push(buildPaxRecord('size', String(params.size)));
  }

  const typeflag = (() => {
    if (params.type === 'directory') return '5';
    if (params.type === 'symlink') return '2';
    return '0';
  })();

  const mainHeader = buildUstarBlock({
    name: Buffer.from(entryPath, 'utf8').subarray(0, 100).toString('ascii'),
    typeflag,
    size: params.type === 'file' ? params.size : 0,
    mode: params.mode,
    mtimeSeconds: params.mtimeSeconds,
    linkname: Buffer.from(linkname, 'utf8').subarray(0, 100).toString('ascii')
  });

  if (paxRecords.length === 0) {
    return mainHeader;
  }

  const paxPayload = Buffer.concat(paxRecords);
  const paxHeader = buildUstarBlock({
    name: 'PaxHeader/entry',
    typeflag: 'x',
    size: paxPayload.length,
    mode: 0o644,
    mtimeSeconds: params.mtimeSeconds,
    linkname: ''
  });
  const remainder = paxPayload.length % TAR_BLOCK_SIZE;
  const paxPadding =
    remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0);

  return Buffer.concat([paxHeader, paxPayload, paxPadding, mainHeader]);
};

/**
 * 将内存条目数组构建为标准 `.tar.gz` Buffer（支持目录、普通文件、软链接与长路径 PAX 扩展）。
 */
export const buildTarGzBuffer = async (params: {
  entries: TarEntryInput[];
  gzipLevel?: number;
}): Promise<Buffer> => {
  const tarChunks: Buffer[] = [];

  for (const entry of params.entries) {
    const type: TarEntryType = entry.type ?? (entry.path.endsWith('/') ? 'directory' : 'file');
    const normalizedPath = normalizeArchiveEntryPath(entry.path, {
      allowTrailingSlash: type === 'directory'
    });
    if (!normalizedPath) continue;

    const contentBuffer = (() => {
      if (type !== 'file') return Buffer.alloc(0);
      if (!entry.content) return Buffer.alloc(0);
      return Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    })();

    if (type === 'symlink') {
      validateArchiveSymlinkTarget({
        entryPath: normalizedPath,
        linkTarget: entry.linkname ?? ''
      });
    }

    const defaultMode = (() => {
      if (type === 'directory') return 0o755;
      if (type === 'symlink') return 0o777;
      return 0o644;
    })();
    const mtimeSeconds = (() => {
      if (entry.mtime instanceof Date) return Math.floor(entry.mtime.getTime() / 1000);
      if (typeof entry.mtime === 'number') return Math.floor(entry.mtime / 1000);
      return Math.floor(Date.now() / 1000);
    })();

    const header = encodeTarHeader({
      path: normalizedPath,
      type,
      size: contentBuffer.length,
      mode: (entry.mode ?? defaultMode) & 0o0777,
      mtimeSeconds,
      linkname: entry.linkname
    });
    tarChunks.push(header);

    if (type === 'file' && contentBuffer.length > 0) {
      tarChunks.push(contentBuffer);
      const remainder = contentBuffer.length % TAR_BLOCK_SIZE;
      if (remainder !== 0) {
        tarChunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
      }
    }
  }

  // TAR 结束标记：两个全 0 的 512 字节块
  tarChunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  const tarBuffer = Buffer.concat(tarChunks);

  return new Promise<Buffer>((resolve, reject) => {
    zlib.gzip(
      tarBuffer,
      { level: params.gzipLevel ?? zlib.constants.Z_BEST_SPEED },
      (err, compressed) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(compressed);
      }
    );
  });
};

/**
 * 流式扫描或解析 `.tar.gz` 数据源，支持 USTAR、PAX ('x'/'g') 与 GNU LongName/LongLink ('L'/'K')。
 * 同时强制执行路径穿越拦截、软链接逃逸拦截、最大条目数限制和真实解压字节数限制。
 */
export const scanTarGzEntries = async (params: {
  source: Buffer | Readable;
  maxUncompressedBytes?: number;
  maxEntries?: number;
  shouldReadContent?: (entry: { path: string; type: TarEntryType; size: number }) => boolean;
  onEntry: (entry: ParsedTarEntry) => Promise<void> | void;
}): Promise<{ entryCount: number; totalUncompressedBytes: number }> => {
  const maxUncompressedBytes = params.maxUncompressedBytes ?? Number.POSITIVE_INFINITY;
  const maxEntries = params.maxEntries ?? SANDBOX_ARCHIVE_MAX_ENTRIES;
  const shouldReadContent = params.shouldReadContent ?? (() => true);

  const sourceStream = Buffer.isBuffer(params.source)
    ? Readable.from([params.source])
    : params.source;
  const gunzip = zlib.createGunzip();

  const parseOctal = (buf: Buffer, offset: number, length: number): number => {
    // 支持 GNU base-256 扩展（最高位为 0x80）与标准八进制
    if ((buf[offset] & 0x80) !== 0) {
      let value = 0;
      for (let i = offset + 1; i < offset + length; i += 1) {
        value = value * 256 + buf[i];
      }
      return value;
    }
    const raw = buf
      .subarray(offset, offset + length)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    return raw ? Number.parseInt(raw, 8) : 0;
  };

  const parseNullTerminatedString = (buf: Buffer, offset: number, length: number): string => {
    const slice = buf.subarray(offset, offset + length);
    const nullIndex = slice.indexOf(0);
    return (nullIndex >= 0 ? slice.subarray(0, nullIndex) : slice).toString('utf8');
  };

  const parsePaxRecords = (payload: Buffer): Record<string, string> => {
    const result: Record<string, string> = {};
    let offset = 0;
    while (offset < payload.length) {
      const newlineIdx = payload.indexOf(0x0a, offset);
      if (newlineIdx === -1) break;
      const line = payload.subarray(offset, newlineIdx).toString('utf8');
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx > 0) {
        const kv = line.slice(spaceIdx + 1);
        const eqIdx = kv.indexOf('=');
        if (eqIdx > 0) {
          result[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
        }
      }
      offset = newlineIdx + 1;
    }
    return result;
  };

  // 使用增量块读取器消费 gunzip 输出流，避免将整个解压后的 tar 缓存在内存中
  let bufferQueue: Buffer[] = [];
  let queuedBytes = 0;

  const pullBytes = (count: number): Buffer => {
    if (count === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    while (copied < count && bufferQueue.length > 0) {
      const head = bufferQueue[0];
      const toCopy = Math.min(count - copied, head.length);
      head.copy(out, copied, 0, toCopy);
      copied += toCopy;
      queuedBytes -= toCopy;
      if (toCopy === head.length) {
        bufferQueue.shift();
      } else {
        bufferQueue[0] = head.subarray(toCopy);
      }
    }
    return out;
  };

  const discardBytes = (count: number) => {
    let remaining = count;
    while (remaining > 0 && bufferQueue.length > 0) {
      const head = bufferQueue[0];
      const toDrop = Math.min(remaining, head.length);
      remaining -= toDrop;
      queuedBytes -= toDrop;
      if (toDrop === head.length) {
        bufferQueue.shift();
      } else {
        bufferQueue[0] = head.subarray(toDrop);
      }
    }
  };

  sourceStream.on('error', (err) => gunzip.destroy(err));
  sourceStream.pipe(gunzip);

  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let pendingPax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};
  let pendingGnuLongPath: string | undefined;
  let pendingGnuLongLink: string | undefined;
  let reachedEof = false;

  type ParserState =
    | { phase: 'header' }
    | {
        phase: 'metaPayload';
        metaType: 'x' | 'g' | 'L' | 'K';
        size: number;
        paddedSize: number;
      }
    | {
        phase: 'entryPayload';
        path: string;
        type: TarEntryType;
        size: number;
        paddedSize: number;
        mode: number;
        mtime: number;
        linkname?: string;
        collectContent: boolean;
        collectedChunks: Buffer[];
        remainingContentBytes: number;
        remainingPaddingBytes: number;
      };

  let state: ParserState = { phase: 'header' };

  for await (const chunk of gunzip) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0 || reachedEof) continue;
    bufferQueue.push(buf);
    queuedBytes += buf.length;

    while (!reachedEof) {
      if (state.phase === 'header') {
        if (queuedBytes < TAR_BLOCK_SIZE) break;
        const headerBlock = pullBytes(TAR_BLOCK_SIZE);

        // 全 0 块表示 TAR 归档结束
        if (headerBlock.every((byte) => byte === 0)) {
          reachedEof = true;
          bufferQueue = [];
          queuedBytes = 0;
          break;
        }

        const typeflagChar = headerBlock[156] === 0 ? '0' : String.fromCharCode(headerBlock[156]);
        const rawSize = parseOctal(headerBlock, 124, 12);
        const paddedSize = Math.ceil(rawSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

        if (
          typeflagChar === 'x' ||
          typeflagChar === 'g' ||
          typeflagChar === 'L' ||
          typeflagChar === 'K'
        ) {
          if (rawSize > 4 * 1024 * 1024) {
            throw new Error('TAR metadata header exceeds maximum allowed size');
          }
          state = {
            phase: 'metaPayload',
            metaType: typeflagChar,
            size: rawSize,
            paddedSize
          };
          continue;
        }

        const ustarName = parseNullTerminatedString(headerBlock, 0, 100);
        const ustarPrefix = parseNullTerminatedString(headerBlock, 345, 155);
        const combinedUstarPath = ustarPrefix ? `${ustarPrefix}/${ustarName}` : ustarName;
        const rawPath =
          pendingPax.path ?? pendingGnuLongPath ?? globalPax.path ?? combinedUstarPath;
        const rawLinkname =
          pendingPax.linkpath ??
          pendingGnuLongLink ??
          globalPax.linkpath ??
          parseNullTerminatedString(headerBlock, 157, 100);
        const entrySize =
          pendingPax.size !== undefined ? Number.parseInt(pendingPax.size, 10) : rawSize;
        const entryPaddedSize = Math.ceil(entrySize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
        const mode = parseOctal(headerBlock, 100, 8) & 0o0777;
        const mtime = parseOctal(headerBlock, 136, 12);

        pendingPax = {};
        pendingGnuLongPath = undefined;
        pendingGnuLongLink = undefined;

        // 拦截设备节点、FIFO 与 socket
        if (
          typeflagChar === '3' ||
          typeflagChar === '4' ||
          typeflagChar === '6' ||
          typeflagChar === '1'
        ) {
          throw new Error(`Unsupported tar entry typeflag (${typeflagChar}) for path: ${rawPath}`);
        }

        const entryType: TarEntryType = (() => {
          if (typeflagChar === '5' || rawPath.endsWith('/')) return 'directory';
          if (typeflagChar === '2') return 'symlink';
          return 'file';
        })();

        const normalizedPath = normalizeArchiveEntryPath(rawPath);
        if (!normalizedPath) {
          // 跳过根目录 '.' 条目
          state = {
            phase: 'entryPayload',
            path: '',
            type: 'directory',
            size: 0,
            paddedSize: entryPaddedSize,
            mode,
            mtime,
            collectContent: false,
            collectedChunks: [],
            remainingContentBytes: entrySize,
            remainingPaddingBytes: entryPaddedSize - entrySize
          };
          continue;
        }

        entryCount += 1;
        if (entryCount > maxEntries) {
          throw new Error(`Archive entry count exceeds maximum allowed limit (${maxEntries})`);
        }

        if (entryType === 'symlink') {
          validateArchiveSymlinkTarget({
            entryPath: normalizedPath,
            linkTarget: rawLinkname
          });
        }

        const effectiveSize = entryType === 'file' ? entrySize : 0;
        totalUncompressedBytes += effectiveSize;
        if (totalUncompressedBytes > maxUncompressedBytes) {
          throw new Error('Archive uncompressed size exceeds maximum allowed limit');
        }

        const collectContent =
          entryType === 'file' &&
          shouldReadContent({ path: normalizedPath, type: entryType, size: effectiveSize });

        state = {
          phase: 'entryPayload',
          path: normalizedPath,
          type: entryType,
          size: effectiveSize,
          paddedSize: entryType === 'file' ? entryPaddedSize : 0,
          mode,
          mtime,
          linkname: entryType === 'symlink' ? rawLinkname : undefined,
          collectContent,
          collectedChunks: [],
          remainingContentBytes: entryType === 'file' ? effectiveSize : 0,
          remainingPaddingBytes: entryType === 'file' ? entryPaddedSize - effectiveSize : 0
        };
        continue;
      }

      if (state.phase === 'metaPayload') {
        if (queuedBytes < state.paddedSize) break;
        const payload = pullBytes(state.size);
        discardBytes(state.paddedSize - state.size);

        if (state.metaType === 'x') {
          pendingPax = { ...pendingPax, ...parsePaxRecords(payload) };
        } else if (state.metaType === 'g') {
          globalPax = { ...globalPax, ...parsePaxRecords(payload) };
        } else if (state.metaType === 'L') {
          pendingGnuLongPath = payload.toString('utf8').replace(/\0+$/, '');
        } else if (state.metaType === 'K') {
          pendingGnuLongLink = payload.toString('utf8').replace(/\0+$/, '');
        }

        state = { phase: 'header' };
        continue;
      }

      if (state.phase === 'entryPayload') {
        if (state.remainingContentBytes > 0) {
          if (queuedBytes === 0) break;
          const take = Math.min(queuedBytes, state.remainingContentBytes);
          if (state.collectContent) {
            state.collectedChunks.push(pullBytes(take));
          } else {
            discardBytes(take);
          }
          state.remainingContentBytes -= take;
          if (state.remainingContentBytes > 0) break;
        }

        if (state.remainingPaddingBytes > 0) {
          if (queuedBytes < state.remainingPaddingBytes) break;
          discardBytes(state.remainingPaddingBytes);
          state.remainingPaddingBytes = 0;
        }

        if (state.path) {
          await params.onEntry({
            path: state.path,
            type: state.type,
            size: state.size,
            mode: state.mode,
            mtime: state.mtime,
            linkname: state.linkname,
            content: state.collectContent ? Buffer.concat(state.collectedChunks) : Buffer.alloc(0)
          });
        }

        state = { phase: 'header' };
      }
    }
  }

  if (state.phase !== 'header') {
    throw new Error('Unexpected EOF while reading tar.gz archive');
  }

  return { entryCount, totalUncompressedBytes };
};

/**
 * 解析 `.tar.gz` 并返回所有条目。仅用于测试或小包解析，大包请使用 `scanTarGzEntries`。
 */
export const parseTarGzEntries = async (
  input:
    | Buffer
    | Readable
    | {
        source: Buffer | Readable;
        maxUncompressedBytes?: number;
        maxEntries?: number;
      }
): Promise<ParsedTarEntry[]> => {
  const params = Buffer.isBuffer(input) || input instanceof Readable ? { source: input } : input;
  const entries: ParsedTarEntry[] = [];
  await scanTarGzEntries({
    ...params,
    onEntry: (entry) => {
      entries.push(entry);
    }
  });
  return entries;
};

/**
 * 使用 `yauzl` 懒加载流式读取本地磁盘 `.zip` 文件或内存 `.zip` Buffer，
 * 并在校验路径穿越、软链接逃逸、最大条目数与真实解压字节数后，流式写入目标 `.tar.gz` Writable 或返回 `.tar.gz` Readable。
 */
const openYauzlZip = (source: { filePath: string } | { buffer: Buffer }): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) => {
    const options: yauzl.Options = {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    };
    const callback = (err: Error | null, zipfile?: yauzl.ZipFile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('Failed to open zip archive'));
        return;
      }
      resolve(zipfile);
    };

    if ('filePath' in source) {
      yauzl.open(source.filePath, options, callback);
    } else {
      yauzl.fromBuffer(source.buffer, options, callback);
    }
  });

const openYauzlReadStream = (zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> =>
  new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error(`Failed to open zip entry stream: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });

/**
 * 将 `.zip`（文件路径或 Buffer）通过 `yauzl` 懒加载逐条转换为 `.tar.gz` 流，
 * 全程不落地全量解压目录，且按真实解压字节数防炸弹。
 */
export const convertZipSourceToTarGzStream = (
  source: { filePath: string } | { buffer: Buffer },
  options?: ConvertZipToTarGzOptions
): Readable => {
  const maxUncompressedBytes = options?.maxUncompressedBytes ?? Number.POSITIVE_INFINITY;
  const maxEntries = options?.maxEntries ?? SANDBOX_ARCHIVE_MAX_ENTRIES;
  const gzip = zlib.createGzip({ level: options?.gzipLevel ?? zlib.constants.Z_BEST_SPEED });
  const output = new PassThrough();

  gzip.on('error', (err) => output.destroy(err));
  gzip.pipe(output);

  const writeToGzip = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    if (!gzip.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          gzip.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          gzip.off('drain', onDrain);
          reject(err);
        };
        gzip.once('drain', onDrain);
        gzip.once('error', onError);
      });
    }
  };

  void (async () => {
    let zipfile: yauzl.ZipFile | undefined;
    try {
      zipfile = await openYauzlZip(source);
      let entryCount = 0;
      let totalUncompressedBytes = 0;

      const processEntries = (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          if (!zipfile) {
            resolve();
            return;
          }

          let settled = false;
          const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            try {
              zipfile?.close();
            } catch {}
            reject(err instanceof Error ? err : new Error(String(err)));
          };

          zipfile.on('error', fail);
          zipfile.on('end', () => {
            if (settled) return;
            settled = true;
            resolve();
          });

          zipfile.on('entry', (entry: yauzl.Entry) => {
            void (async () => {
              try {
                const rawFileName = entry.fileName.replace(/\\/g, '/');
                // 跳过 macOS 资源分叉元数据目录
                if (
                  rawFileName.startsWith('__MACOSX/') ||
                  rawFileName.includes('/__MACOSX/') ||
                  path.posix.basename(rawFileName).startsWith('._')
                ) {
                  zipfile?.readEntry();
                  return;
                }

                const isDir = rawFileName.endsWith('/');
                const normalizedPath = normalizeArchiveEntryPath(rawFileName);
                if (!normalizedPath) {
                  zipfile?.readEntry();
                  return;
                }

                entryCount += 1;
                if (entryCount > maxEntries) {
                  throw new Error(
                    `Archive entry count exceeds maximum allowed limit (${maxEntries})`
                  );
                }

                const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
                const fileTypeBits = unixMode & S_IFMT;

                // 拦截 FIFO / 字符设备 / 块设备 / Socket
                if (
                  fileTypeBits === S_IFIFO ||
                  fileTypeBits === S_IFCHR ||
                  fileTypeBits === S_IFBLK ||
                  fileTypeBits === S_IFSOCK
                ) {
                  throw new Error(`Unsupported special file in zip archive: ${normalizedPath}`);
                }

                const isSymlink = fileTypeBits === S_IFLNK;
                const mtimeSeconds = Math.floor(entry.getLastModDate().getTime() / 1000);

                if (isDir || fileTypeBits === S_IFDIR) {
                  const dirMode = unixMode & 0o0777 || 0o755;
                  await writeToGzip(
                    encodeTarHeader({
                      path: normalizedPath,
                      type: 'directory',
                      size: 0,
                      mode: dirMode,
                      mtimeSeconds
                    })
                  );
                  await options?.onEntry?.({
                    path: normalizedPath,
                    type: 'directory',
                    size: 0
                  });
                  zipfile?.readEntry();
                  return;
                }

                if (isSymlink) {
                  if (entry.uncompressedSize > 4096) {
                    throw new Error(`Symlink target too long: ${normalizedPath}`);
                  }
                  const entryStream = await openYauzlReadStream(zipfile!, entry);
                  const targetChunks: Buffer[] = [];
                  for await (const chunk of entryStream) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    totalUncompressedBytes += buf.length;
                    if (totalUncompressedBytes > maxUncompressedBytes) {
                      throw new Error('Archive uncompressed size exceeds maximum allowed limit');
                    }
                    targetChunks.push(buf);
                  }
                  const linkTarget = Buffer.concat(targetChunks).toString('utf8');
                  validateArchiveSymlinkTarget({
                    entryPath: normalizedPath,
                    linkTarget
                  });

                  await writeToGzip(
                    encodeTarHeader({
                      path: normalizedPath,
                      type: 'symlink',
                      size: 0,
                      mode: 0o777,
                      mtimeSeconds,
                      linkname: linkTarget
                    })
                  );
                  await options?.onEntry?.({
                    path: normalizedPath,
                    type: 'symlink',
                    size: 0
                  });
                  zipfile?.readEntry();
                  return;
                }

                // 普通文件：声明大小先做快速预检，真实解压流再按实际字节严格计数
                if (totalUncompressedBytes + entry.uncompressedSize > maxUncompressedBytes) {
                  throw new Error('Archive uncompressed size exceeds maximum allowed limit');
                }

                const fileMode = unixMode & 0o0777 || 0o644;
                await writeToGzip(
                  encodeTarHeader({
                    path: normalizedPath,
                    type: 'file',
                    size: entry.uncompressedSize,
                    mode: fileMode,
                    mtimeSeconds
                  })
                );

                let capturedChunks: Buffer[] | undefined;
                if (options?.onEntry) {
                  await options.onEntry({
                    path: normalizedPath,
                    type: 'file',
                    size: entry.uncompressedSize,
                    readContent: async () => {
                      capturedChunks = [];
                      return Buffer.alloc(0);
                    }
                  });
                }

                const entryStream = await openYauzlReadStream(zipfile!, entry);
                let actualEntryBytes = 0;
                for await (const chunk of entryStream) {
                  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  actualEntryBytes += buf.length;
                  totalUncompressedBytes += buf.length;
                  if (totalUncompressedBytes > maxUncompressedBytes) {
                    entryStream.destroy();
                    throw new Error('Archive uncompressed size exceeds maximum allowed limit');
                  }
                  if (capturedChunks) {
                    capturedChunks.push(buf);
                  }
                  await writeToGzip(buf);
                }

                if (actualEntryBytes !== entry.uncompressedSize) {
                  throw new Error(
                    `Zip entry size mismatch for ${normalizedPath}: expected ${entry.uncompressedSize}, got ${actualEntryBytes}`
                  );
                }

                const remainder = actualEntryBytes % TAR_BLOCK_SIZE;
                if (remainder !== 0) {
                  await writeToGzip(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
                }

                if (capturedChunks && options?.onEntry) {
                  const fullBuffer = Buffer.concat(capturedChunks);
                  await options.onEntry({
                    path: normalizedPath,
                    type: 'file',
                    size: actualEntryBytes,
                    readContent: async () => fullBuffer
                  });
                }

                zipfile?.readEntry();
              } catch (err) {
                fail(err);
              }
            })();
          });

          zipfile.readEntry();
        });

      await processEntries();
      await writeToGzip(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
      gzip.end();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      gzip.destroy(error);
      output.destroy(error);
    } finally {
      try {
        zipfile?.close();
      } catch {}
    }
  })();

  return output;
};

/**
 * 将内存 `.zip` Buffer 转换为 `.tar.gz` Buffer。
 */
export const convertZipBufferToTarGzBuffer = async (
  zipBuffer: Buffer,
  options?: ConvertZipToTarGzOptions
): Promise<Buffer> => {
  const stream = convertZipSourceToTarGzStream({ buffer: zipBuffer }, options);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * 将 `.zip` Readable 流通过临时文件落盘后由 `yauzl.open` 懒加载转换为 `.tar.gz` Readable 流，
 * 避免在服务端内存中持有完整的 `.zip` Buffer。流消费结束或报错时自动清理临时文件。
 */
export const convertZipStreamToTarGzStream = async (params: {
  zipStream: Readable;
  maxCompressedBytes?: number;
  options?: ConvertZipToTarGzOptions;
}): Promise<Readable> => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fastgpt-zip2tgz-'));
  const tempZipPath = path.join(tempDir, 'input.zip');
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // 1. 将输入 .zip 流限流写入本地临时文件，供 yauzl 基于文件描述符按需读取中央目录
    const writeStream = fs.createWriteStream(tempZipPath, { mode: 0o600 });
    let writtenBytes = 0;
    const maxCompressedBytes = params.maxCompressedBytes ?? Number.POSITIVE_INFINITY;

    const limiter = new PassThrough({
      transform(chunk: Buffer, _encoding, callback) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        writtenBytes += buf.length;
        if (writtenBytes > maxCompressedBytes) {
          callback(new Error('Compressed zip archive exceeds maximum allowed size'));
          return;
        }
        callback(null, buf);
      }
    });

    await pipeline(params.zipStream, limiter, writeStream);

    // 2. 启动 yauzl -> tar -> gzip 流，并在流结束/关闭/报错时清理临时目录
    const tarGzStream = convertZipSourceToTarGzStream({ filePath: tempZipPath }, params.options);
    tarGzStream.once('close', () => {
      void cleanup();
    });
    tarGzStream.once('error', () => {
      void cleanup();
    });
    return tarGzStream;
  } catch (err) {
    await cleanup();
    throw err;
  }
};
