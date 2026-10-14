import type { Readable } from 'node:stream';
import { S3PrivateBucket } from '../../buckets/private';
import { readStreamToBuffer } from '../../utils';
import { createSizeLimitedStream } from '../../../file/stream';
import { convertZipStreamToTarGzStream } from '../../../file/archive/tarGz';
import { type ArchiveStreamBody, uploadStreamPartsToS3 } from '../../utils/multipartStream';

export const SANDBOX_WORKSPACE_ARCHIVE_FILENAME = 'package.tar.gz';
export const SANDBOX_WORKSPACE_LEGACY_ARCHIVE_FILENAME = 'package.zip';

export const getWorkspaceArchiveKey = (sandboxId: string): string =>
  `sandbox/archive/${sandboxId}/${SANDBOX_WORKSPACE_ARCHIVE_FILENAME}`;

export const getLegacyWorkspaceArchiveKey = (sandboxId: string): string =>
  `sandbox/archive/${sandboxId}/${SANDBOX_WORKSPACE_LEGACY_ARCHIVE_FILENAME}`;

export type WorkspaceArchiveBody = ArchiveStreamBody;

export class S3SandboxSource extends S3PrivateBucket {
  constructor() {
    super();
  }

  private async uploadWorkspaceArchiveByKey(params: {
    key: string;
    body: WorkspaceArchiveBody;
    maxBytes?: number;
  }) {
    await uploadStreamPartsToS3({
      client: this.client,
      key: params.key,
      body: params.body,
      contentType: 'application/gzip',
      filename: SANDBOX_WORKSPACE_ARCHIVE_FILENAME,
      maxBytes: params.maxBytes,
      createExceededError: (limit) =>
        new Error(`Sandbox archive exceeds maximum allowed size (${limit} bytes)`)
    });
  }

  private async downloadWorkspaceArchiveByKey(params: {
    key: string;
    sandboxId: string;
    maxBytes?: number;
  }) {
    const response = await this.client.downloadObject({ key: params.key });
    if (!response.body) {
      throw new Error(`Failed to download sandbox archive: ${params.sandboxId}`);
    }

    return readStreamToBuffer({
      stream: response.body,
      maxBytes: params.maxBytes,
      exceededMessage:
        params.maxBytes === undefined
          ? undefined
          : `Sandbox archive exceeds maximum allowed size (${params.maxBytes} bytes)`
    });
  }

  private async deleteWorkspaceArchiveNowByKey(params: { key: string; sandboxId: string }) {
    const { key, sandboxId } = params;
    await this.removeObject(key);
    if (await this.isObjectExists(key)) {
      throw new Error(`Failed to delete sandbox archive: ${sandboxId}`);
    }
  }

  /**
   * 确保指定 Sandbox 的冷归档在 S3 中为 `.tar.gz` 格式：
   * - 若 `package.tar.gz` 已存在，顺带清理可能残留的 `package.zip`；
   * - 若仅存在旧版 `package.zip`，通过 `yauzl` 流式转换为 `package.tar.gz` 并上传，成功后删除 `package.zip`。
   */
  async ensureTarGzWorkspaceArchive(params: {
    sandboxId: string;
    maxBytes?: number;
  }): Promise<{ key: string; migrated: boolean }> {
    const tarGzKey = getWorkspaceArchiveKey(params.sandboxId);
    const legacyZipKey = getLegacyWorkspaceArchiveKey(params.sandboxId);

    if (typeof this.isObjectExists !== 'function') {
      return { key: tarGzKey, migrated: false };
    }

    if (await this.isObjectExists(tarGzKey)) {
      if (await this.isObjectExists(legacyZipKey)) {
        await this.removeObject(legacyZipKey).catch(() => undefined);
      }
      return { key: tarGzKey, migrated: false };
    }

    if (!(await this.isObjectExists(legacyZipKey))) {
      return { key: tarGzKey, migrated: false };
    }

    const legacyResponse = await this.client.downloadObject({ key: legacyZipKey });
    if (!legacyResponse.body) {
      throw new Error(`Failed to download legacy sandbox archive: ${params.sandboxId}`);
    }

    const tarGzStream = await convertZipStreamToTarGzStream({
      zipStream: legacyResponse.body,
      maxCompressedBytes: params.maxBytes,
      options: {
        maxUncompressedBytes: params.maxBytes
      }
    });

    await this.uploadWorkspaceArchiveByKey({
      key: tarGzKey,
      body: tarGzStream,
      maxBytes: params.maxBytes
    });

    await this.deleteWorkspaceArchiveNowByKey({
      key: legacyZipKey,
      sandboxId: params.sandboxId
    });

    return { key: tarGzKey, migrated: true };
  }

  /** 上传 v2 Sandbox 的完整 Workspace `.tar.gz` 归档，并清理可能存在的旧版 `.zip`。 */
  async uploadWorkspaceArchive(params: {
    sandboxId: string;
    body: WorkspaceArchiveBody;
    maxBytes?: number;
  }) {
    await this.uploadWorkspaceArchiveByKey({
      key: getWorkspaceArchiveKey(params.sandboxId),
      body: params.body,
      maxBytes: params.maxBytes
    });

    if (typeof this.isObjectExists === 'function') {
      const legacyKey = getLegacyWorkspaceArchiveKey(params.sandboxId);
      if (await this.isObjectExists(legacyKey)) {
        await this.removeObject(legacyKey).catch(() => undefined);
      }
    }
  }

  /** 流式分片上传 v2 Sandbox 的 Workspace `.tar.gz` 归档。 */
  uploadWorkspaceArchiveStream(params: {
    sandboxId: string;
    stream: AsyncIterable<Buffer | Uint8Array> | Readable;
    maxBytes?: number;
  }) {
    return this.uploadWorkspaceArchive({
      sandboxId: params.sandboxId,
      body: params.stream,
      maxBytes: params.maxBytes
    });
  }

  /** 下载 v2 Sandbox 的完整 Workspace 归档（若仍为旧版 `.zip` 会先自动原位迁移为 `.tar.gz`）。 */
  async downloadWorkspaceArchive(params: { sandboxId: string; maxBytes?: number }) {
    await this.ensureTarGzWorkspaceArchive(params);
    return this.downloadWorkspaceArchiveByKey({
      ...params,
      key: getWorkspaceArchiveKey(params.sandboxId)
    });
  }

  /** 流式下载 v2 Sandbox 的 Workspace `.tar.gz` 归档（若仍为旧版 `.zip` 会先自动原位迁移为 `.tar.gz`）。 */
  async downloadWorkspaceArchiveStream(params: {
    sandboxId: string;
    maxBytes?: number;
  }): Promise<Readable> {
    await this.ensureTarGzWorkspaceArchive(params);
    const key = getWorkspaceArchiveKey(params.sandboxId);
    const response = await this.client.downloadObject({ key });
    if (!response.body) {
      throw new Error(`Failed to download sandbox archive: ${params.sandboxId}`);
    }

    if (params.maxBytes === undefined) {
      return response.body;
    }

    return createSizeLimitedStream({
      stream: response.body,
      maxBytes: params.maxBytes,
      createExceededError: () =>
        new Error(`Sandbox archive exceeds maximum allowed size (${params.maxBytes} bytes)`)
    });
  }

  /** 同步删除 v2 Sandbox 的 Workspace 归档（同时覆盖 `.tar.gz` 与旧版 `.zip`），返回前保证均已不存在。 */
  async deleteWorkspaceArchiveNow(params: { sandboxId: string }) {
    await this.deleteWorkspaceArchiveNowByKey({
      ...params,
      key: getWorkspaceArchiveKey(params.sandboxId)
    });
    await this.deleteWorkspaceArchiveNowByKey({
      ...params,
      key: getLegacyWorkspaceArchiveKey(params.sandboxId)
    });
  }

  /** 检查指定 v2 Sandbox 的 Workspace 归档是否存在（包含 `.tar.gz` 或旧版 `.zip`）。 */
  async isWorkspaceArchiveExists(params: { sandboxId: string }) {
    if (await this.isObjectExists(getWorkspaceArchiveKey(params.sandboxId))) {
      return true;
    }
    return this.isObjectExists(getLegacyWorkspaceArchiveKey(params.sandboxId));
  }
}

export function getS3SandboxSource() {
  if (global.sandboxBucket) {
    return global.sandboxBucket;
  }
  global.sandboxBucket = new S3SandboxSource();
  return global.sandboxBucket;
}
