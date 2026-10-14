import { Readable } from 'node:stream';
import type { IStorage } from '@fastgpt-sdk/storage';
import { encodeS3Filename, getS3UploadContentDisposition } from '../filename';
import { EMPTY_TAR_GZ_BUFFER } from '../../../core/ai/sandbox/application/streamArchive';
import { SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES } from '../../../core/ai/sandbox/constants';

export type ArchiveStreamBody = Buffer | string | Readable | AsyncIterable<Buffer | Uint8Array>;

export type UploadStreamPartsToS3Params = {
  client: IStorage;
  key: string;
  body: ArchiveStreamBody;
  contentType: string;
  filename: string;
  contentLength?: number;
  partSizeBytes?: number;
  maxBytes?: number;
  createExceededError?: (maxBytes: number) => Error;
};

/**
 * 将 Buffer、Readable 或分片 AsyncIterable 上传至 S3：
 * 1. 若总大小 <= 1 个分片（8 MiB），自动退化为单次 `uploadObject`（带精确 Content-Length），
 *    避免触发 S3 Multipart 对非末片 >= 5 MiB 的限制且减少网络往返；
 * 2. 若超过 1 个分片，自动启用 `createMultipartUpload` -> `uploadMultipartPart` -> `completeMultipartUpload`，
 *    并在异常或超限时在 catch 中执行 `abortMultipartUpload` 防止 S3 残留未完成分片。
 */
export const uploadStreamPartsToS3 = async (
  params: UploadStreamPartsToS3Params
): Promise<{ totalBytes: number }> => {
  const {
    client,
    key,
    body,
    contentType,
    filename,
    contentLength,
    partSizeBytes = SANDBOX_ARCHIVE_STREAM_CHUNK_BYTES,
    maxBytes,
    createExceededError = (limit) =>
      new Error(`Archive exceeds maximum allowed size (${limit} bytes)`)
  } = params;

  const contentDisposition = getS3UploadContentDisposition({ filename, type: 'attachment' });
  const metadata = {
    uploadTime: new Date().toISOString(),
    originFilename: encodeS3Filename(filename)
  };

  // 1. Buffer 或 string：直接校验大小后单次 uploadObject
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      throw createExceededError(maxBytes);
    }
    await client.uploadObject({
      key,
      body: buffer,
      contentLength: buffer.byteLength,
      contentType,
      contentDisposition,
      metadata
    });
    return { totalBytes: buffer.byteLength };
  }

  // 2. 已知 contentLength 的 Readable 或测试 Mock 未提供 createMultipartUpload 时，直接走 uploadObject
  if (
    body instanceof Readable &&
    (contentLength !== undefined || typeof client.createMultipartUpload !== 'function')
  ) {
    if (maxBytes !== undefined && contentLength !== undefined && contentLength > maxBytes) {
      body.destroy();
      throw createExceededError(maxBytes);
    }
    await client.uploadObject({
      key,
      body,
      contentLength,
      contentType,
      contentDisposition,
      metadata
    });
    return { totalBytes: contentLength ?? 0 };
  }

  // 3. 未知总长度的 AsyncIterable / Readable：按 8 MiB 分片聚合，单分片走 uploadObject，多分片走 Multipart
  const iterator = body[Symbol.asyncIterator]();
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let sourceDone = false;

  const pullNextPart = async (): Promise<Buffer | null> => {
    while (pendingBytes < partSizeBytes && !sourceDone) {
      const next = await iterator.next();
      if (next.done) {
        sourceDone = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.byteLength === 0) continue;

      totalBytes += chunk.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        throw createExceededError(maxBytes);
      }

      pendingChunks.push(chunk);
      pendingBytes += chunk.byteLength;
    }

    if (pendingBytes === 0) {
      return null;
    }

    const combined =
      pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks, pendingBytes);

    if (combined.byteLength <= partSizeBytes) {
      pendingChunks = [];
      pendingBytes = 0;
      return combined;
    }

    const part = combined.subarray(0, partSizeBytes);
    const remainder = combined.subarray(partSizeBytes);
    pendingChunks = [remainder];
    pendingBytes = remainder.byteLength;
    return part;
  };

  try {
    const firstPart = (await pullNextPart()) ?? EMPTY_TAR_GZ_BUFFER;
    const secondPart = await pullNextPart();

    if (!secondPart || typeof client.createMultipartUpload !== 'function') {
      const singleBuffer = secondPart ? Buffer.concat([firstPart, secondPart]) : firstPart;
      await client.uploadObject({
        key,
        body: singleBuffer,
        contentLength: singleBuffer.byteLength,
        contentType,
        contentDisposition,
        metadata
      });
      return { totalBytes: singleBuffer.byteLength };
    }

    const { uploadId } = await client.createMultipartUpload({
      key,
      contentType,
      contentDisposition,
      metadata
    });

    try {
      const completedParts: Array<{ partNumber: number; etag: string }> = [];

      const part1Result = await client.uploadMultipartPart({
        key,
        uploadId,
        partNumber: 1,
        body: firstPart,
        contentLength: firstPart.byteLength
      });
      completedParts.push({ partNumber: 1, etag: part1Result.etag });

      let currentPart: Buffer | null = secondPart;
      let partNumber = 2;

      while (currentPart) {
        const partResult = await client.uploadMultipartPart({
          key,
          uploadId,
          partNumber,
          body: currentPart,
          contentLength: currentPart.byteLength
        });
        completedParts.push({ partNumber, etag: partResult.etag });
        partNumber += 1;
        currentPart = await pullNextPart();
      }

      await client.completeMultipartUpload({
        key,
        uploadId,
        parts: completedParts
      });

      return { totalBytes };
    } catch (uploadError) {
      await client.abortMultipartUpload({ key, uploadId }).catch(() => undefined);
      throw uploadError;
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return().catch(() => undefined);
    }
    if (body instanceof Readable && !body.destroyed) {
      body.destroy();
    }
  }
};
