import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import {
  buildTarGzBuffer,
  convertZipBufferToTarGzBuffer,
  convertZipStreamToTarGzStream,
  isGzipBuffer,
  isZipBuffer,
  normalizeArchiveEntryPath,
  parseTarGzEntries,
  scanTarGzEntries,
  validateArchiveSymlinkTarget
} from '@fastgpt/service/common/file/archive/tarGz';
import { uploadStreamPartsToS3 } from '@fastgpt/service/common/s3/utils/multipartStream';

describe('tarGz & yauzl archive utilities', () => {
  it('builds and parses .tar.gz archives while preserving relative paths and modes', async () => {
    const tarGz = await buildTarGzBuffer({
      entries: [
        { path: './SKILL.md', content: '---\nname: Demo\ndescription: Demo\n---\n' },
        { path: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 }
      ]
    });

    expect(isGzipBuffer(tarGz)).toBe(true);
    expect(isZipBuffer(tarGz)).toBe(false);

    const entries = await parseTarGzEntries(tarGz);
    expect(entries).toEqual([
      expect.objectContaining({
        path: 'SKILL.md',
        type: 'file',
        size: 37,
        mode: 0o644,
        content: Buffer.from('---\nname: Demo\ndescription: Demo\n---\n')
      }),
      expect.objectContaining({
        path: 'scripts/run.sh',
        type: 'file',
        size: 18,
        mode: 0o755,
        content: Buffer.from('#!/bin/sh\necho hi\n')
      })
    ]);
  });

  it('rejects path traversal and escaping symlinks', () => {
    expect(() => normalizeArchiveEntryPath('../etc/passwd')).toThrow('Invalid archive entry path');
    expect(() => normalizeArchiveEntryPath('/etc/passwd')).toThrow('Invalid archive entry path');
    expect(() => normalizeArchiveEntryPath('a/../../b')).toThrow('Invalid archive entry path');
    expect(normalizeArchiveEntryPath('./a/b/c.txt')).toBe('a/b/c.txt');

    expect(() =>
      validateArchiveSymlinkTarget({ entryPath: 'sub/link', linkTarget: '../../outside' })
    ).toThrow('Symlink target escapes archive root');
    expect(() =>
      validateArchiveSymlinkTarget({ entryPath: 'sub/link', linkTarget: '/etc/passwd' })
    ).toThrow('Symlink target cannot be absolute path');
    expect(() =>
      validateArchiveSymlinkTarget({ entryPath: 'sub/link', linkTarget: '../sibling/file.txt' })
    ).not.toThrow();
  });

  it('converts a .zip buffer and stream into .tar.gz via yauzl while preserving symlinks', async () => {
    const zip = new JSZip();
    zip.file('SKILL.md', '---\nname: ZipSkill\ndescription: From zip\n---\n');
    zip.file('dir/hello.txt', 'hello world');
    zip.file('dir/latest.txt', 'hello.txt', {
      unixPermissions: 0o120777
    });

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    expect(isZipBuffer(zipBuffer)).toBe(true);

    const tarGzBuffer = await convertZipBufferToTarGzBuffer(zipBuffer);
    expect(isGzipBuffer(tarGzBuffer)).toBe(true);

    const scanned: Array<{ path: string; type: string; linkname?: string }> = [];
    await scanTarGzEntries({
      source: tarGzBuffer,
      onEntry: (entry) => {
        scanned.push({ path: entry.path, type: entry.type, linkname: entry.linkname });
      }
    });

    expect(scanned).toEqual(
      expect.arrayContaining([
        { path: 'SKILL.md', type: 'file', linkname: undefined },
        { path: 'dir/hello.txt', type: 'file', linkname: undefined },
        { path: 'dir/latest.txt', type: 'symlink', linkname: 'hello.txt' }
      ])
    );

    const tarGzStream = await convertZipStreamToTarGzStream({
      zipStream: Readable.from([zipBuffer]),
      maxCompressedBytes: 1024 * 1024
    });
    const streamChunks: Buffer[] = [];
    for await (const chunk of tarGzStream) {
      streamChunks.push(Buffer.from(chunk));
    }
    const streamedTarGz = Buffer.concat(streamChunks);
    expect(isGzipBuffer(streamedTarGz)).toBe(true);
  });

  it('enforces maxUncompressedBytes (Zip Bomb protection) during .zip -> .tar.gz conversion', async () => {
    const zip = new JSZip();
    zip.file('big.txt', 'x'.repeat(2048));
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(
      convertZipBufferToTarGzBuffer(zipBuffer, { maxUncompressedBytes: 512 })
    ).rejects.toThrow('Archive uncompressed size exceeds maximum allowed limit');
  });
});

describe('uploadStreamPartsToS3', () => {
  it('uses single uploadObject when stream fits within one part', async () => {
    const client = {
      uploadObject: vi.fn().mockResolvedValue(undefined),
      createMultipartUpload: vi.fn(),
      uploadMultipartPart: vi.fn(),
      completeMultipartUpload: vi.fn(),
      abortMultipartUpload: vi.fn()
    };

    const res = await uploadStreamPartsToS3({
      client: client as any,
      key: 'test/small.tar.gz',
      body: Readable.from([Buffer.from('part-1'), Buffer.from('-part-2')]),
      contentType: 'application/gzip',
      filename: 'small.tar.gz',
      partSizeBytes: 8 * 1024 * 1024
    });

    expect(res.totalBytes).toBe(13);
    expect(client.uploadObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'test/small.tar.gz',
        body: Buffer.from('part-1-part-2'),
        contentLength: 13
      })
    );
    expect(client.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('uses S3 Multipart Upload when stream spans multiple parts', async () => {
    const client = {
      uploadObject: vi.fn(),
      createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: 'upload-1' }),
      uploadMultipartPart: vi
        .fn()
        .mockResolvedValueOnce({ etag: '"etag-1"' })
        .mockResolvedValueOnce({ etag: '"etag-2"' }),
      completeMultipartUpload: vi.fn().mockResolvedValue(undefined),
      abortMultipartUpload: vi.fn().mockResolvedValue(undefined)
    };

    const chunk1 = Buffer.alloc(5 * 1024 * 1024, 'a');
    const chunk2 = Buffer.alloc(4 * 1024 * 1024, 'b');

    const res = await uploadStreamPartsToS3({
      client: client as any,
      key: 'test/multi.tar.gz',
      body: (async function* () {
        yield chunk1;
        yield chunk2;
      })(),
      contentType: 'application/gzip',
      filename: 'multi.tar.gz',
      partSizeBytes: 5 * 1024 * 1024
    });

    expect(res.totalBytes).toBe(9 * 1024 * 1024);
    expect(client.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect(client.uploadMultipartPart).toHaveBeenCalledTimes(2);
    expect(client.completeMultipartUpload).toHaveBeenCalledWith({
      key: 'test/multi.tar.gz',
      uploadId: 'upload-1',
      parts: [
        { etag: '"etag-1"', partNumber: 1 },
        { etag: '"etag-2"', partNumber: 2 }
      ]
    });
  });
});
