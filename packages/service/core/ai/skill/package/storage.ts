/**
 * Skill 包对象存储服务。
 *
 * 负责 Skill `.tar.gz` 版本包在私有对象存储中的读写、服务端拷贝、存量 `.zip -> .tar.gz` 转换、
 * 存在性检查和清理。
 */

import { Readable } from 'node:stream';
import {
  getS3SkillSource,
  getSkillPackageKey,
  toTarGzSkillStorageKey
} from '../../../../common/s3/sources/skill';
import { SkillErrEnum } from '@fastgpt/global/common/error/code/skill';
import type { ClientSession } from '../../../../common/mongo';
import { getAgentSandboxSkillMaxBytes } from '../../sandbox/config';
import { readStreamToBuffer } from '../../../../common/s3/utils';
import { createSizeLimitedStream } from '../../../../common/file/stream';
import {
  convertZipBufferToTarGzBuffer,
  convertZipStreamToTarGzStream,
  isZipBuffer
} from '../../../../common/file/archive/tarGz';
import { MongoAgentSkillsVersion } from '../version/schema';

export type SkillStorageInfo = {
  key: string;
};

export type UploadSkillPackageParams = {
  teamId: string;
  skillId: string;
  packageObjectId: string;
  zipBuffer: Buffer;
};

export type DownloadSkillPackageParams = {
  storageKey: string;
};

export type UploadSkillPackageStreamParams = Omit<UploadSkillPackageParams, 'zipBuffer'> & {
  packageStream: Readable | AsyncIterable<Buffer | Uint8Array>;
  contentLength?: number;
};

/**
 * 上传 Skill 版本包 Buffer 到私有对象存储（统一存储为 `.tar.gz` key）。
 *
 * 若调用方传入的是 `.zip` Buffer（如旧测试 fixture），会自动转换为 `.tar.gz` 后再落盘，
 * 确保 `.tar.gz` key 下的内容始终是合法 gzip/tar 流。
 */
export async function uploadSkillPackage(
  params: UploadSkillPackageParams
): Promise<SkillStorageInfo> {
  const { teamId, skillId, packageObjectId, zipBuffer } = params;
  const maxBytes = getAgentSandboxSkillMaxBytes();

  if (zipBuffer.length > maxBytes) {
    throw new Error(SkillErrEnum.archiveTooLarge);
  }

  const normalizedBuffer = isZipBuffer(zipBuffer)
    ? await convertZipBufferToTarGzBuffer(zipBuffer, { maxUncompressedBytes: maxBytes })
    : zipBuffer;

  if (normalizedBuffer.length > maxBytes) {
    throw new Error(SkillErrEnum.archiveTooLarge);
  }

  const bucket = getS3SkillSource();

  const { key } = await bucket.uploadPackage({
    teamId,
    skillId,
    packageObjectId,
    body: normalizedBuffer
  });

  return { key };
}

/**
 * 将 Skill 版本包流（Readable 或分片 AsyncIterable）直接上传到私有对象存储。
 *
 * contentLength 仅透传对象存储 SDK；实际传输仍逐块计数，防止伪造长度绕过限制。
 */
export async function uploadSkillPackageStream(
  params: UploadSkillPackageStreamParams
): Promise<SkillStorageInfo> {
  const { teamId, skillId, packageObjectId, packageStream, contentLength } = params;
  const maxBytes = getAgentSandboxSkillMaxBytes();

  const readableStream =
    packageStream instanceof Readable ? packageStream : Readable.from(packageStream);

  const boundedStream = createSizeLimitedStream({
    stream: readableStream,
    maxBytes,
    createExceededError: () => new Error(SkillErrEnum.archiveTooLarge)
  });

  const bucket = getS3SkillSource();
  const { key } = await bucket.uploadPackage({
    teamId,
    skillId,
    packageObjectId,
    body: boundedStream,
    contentLength,
    maxBytes,
    createExceededError: () => new Error(SkillErrEnum.archiveTooLarge)
  });

  return { key };
}

/**
 * 移除 Skill 包的临时 S3 TTL。
 *
 * uploadSkillPackage 通过 S3 bucket 封装上传，默认会写入一条 TTL 记录。只有当版本记录和
 * currentVersionId 在 Mongo 事务内绑定成功后，才移除 TTL；事务失败时 TTL 会保留并由现有
 * S3 cleanup cron 清理孤儿包。
 */
export async function removeSkillPackageTTL(
  storageKey: string,
  session?: ClientSession
): Promise<void> {
  await getS3SkillSource().removePackageTTL(storageKey, session);
}

/**
 * 从私有对象存储下载 Skill 版本包 Buffer。
 *
 * 下载过程中按流式累计大小，超过 Skill sandbox 包大小上限即中断，避免异常大包撑爆内存。
 */
export async function downloadSkillPackage(params: DownloadSkillPackageParams): Promise<Buffer> {
  const { storageKey } = params;
  const maxBytes = getAgentSandboxSkillMaxBytes();

  const bucket = getS3SkillSource();

  const response = await bucket.client.downloadObject({
    key: storageKey
  });

  if (!response.body) {
    throw new Error(`Failed to download skill package: ${storageKey}`);
  }

  return readStreamToBuffer({
    stream: response.body,
    maxBytes,
    exceededMessage: `Skill package exceeds maximum allowed size (${maxBytes / 1024 / 1024}MB)`
  });
}

/**
 * 从私有对象存储返回带实际字节上限的 Skill 版本包流。
 *
 * 上限在消费流时逐块执行，避免对象元数据缺失或被错误填写时把超大包继续传入 Sandbox。
 */
export async function downloadSkillPackageStream(
  params: DownloadSkillPackageParams
): Promise<Readable> {
  const { storageKey } = params;
  const maxBytes = getAgentSandboxSkillMaxBytes();
  const response = await getS3SkillSource().client.downloadObject({
    key: storageKey
  });

  if (!response.body) {
    throw new Error(`Failed to download skill package: ${storageKey}`);
  }

  return createSizeLimitedStream({
    stream: response.body,
    maxBytes,
    createExceededError: () =>
      new Error(`Skill package exceeds maximum allowed size (${maxBytes / 1024 / 1024}MB)`)
  });
}

/**
 * 确保指定 Skill 版本包在 S3 中为 `.tar.gz` 格式：
 * 1. 若 `storageKey` 已以 `.tar.gz` 结尾，直接返回；
 * 2. 若 `storageKey` 仍以 `.zip` 结尾，通过 `yauzl` 流式转换为 `.tar.gz` 上传至 S3，
 *    通过 CAS 更新 `MongoAgentSkillsVersion.storageKey` 后删除旧 `.zip` 对象。
 */
export async function ensureTarGzSkillPackage(params: {
  versionId?: string;
  storageKey: string;
}): Promise<string> {
  const { versionId, storageKey } = params;
  if (!storageKey.toLowerCase().endsWith('.zip')) {
    return storageKey;
  }

  const bucket = getS3SkillSource();
  if (typeof bucket.uploadConfirmedTarGzByKey !== 'function') {
    return storageKey;
  }

  const newTarGzKey = toTarGzSkillStorageKey(storageKey);
  const maxBytes = getAgentSandboxSkillMaxBytes();
  const targetExists = await checkSkillPackageExists(newTarGzKey);

  if (!targetExists) {
    const zipStream = await downloadSkillPackageStream({ storageKey });
    const tarGzStream = await convertZipStreamToTarGzStream({
      zipStream,
      maxCompressedBytes: maxBytes,
      options: {
        maxUncompressedBytes: maxBytes
      }
    });

    await bucket.uploadConfirmedTarGzByKey({
      key: newTarGzKey,
      body: tarGzStream,
      maxBytes
    });
  }

  await MongoAgentSkillsVersion.updateOne(
    {
      ...(versionId ? { _id: versionId } : {}),
      storageKey
    },
    {
      $set: {
        storageKey: newTarGzKey
      }
    }
  ).catch(() => undefined);

  await deleteSkillPackage(storageKey).catch(() => undefined);

  return newTarGzKey;
}

/**
 * 删除单个版本的 Skill 包。
 */
export async function deleteSkillPackage(storageKey: string): Promise<void> {
  const bucket = getS3SkillSource();

  await bucket.client.deleteObject({
    key: storageKey
  });
}

/**
 * 清理某个 skill 的所有版本包。
 *
 * 这里使用异步删除队列，调用方不等待实际对象删除完成；数据库软删除流程不能依赖这个返回值
 * 表示对象已经立刻消失。
 */
export function deleteSkillAllPackages(teamId: string, skillId: string): Promise<void> {
  return getS3SkillSource().deleteSkillPackagesByPrefix({ teamId, skillId });
}

/**
 * 检查 Skill 包是否存在。
 *
 * 对象存储异常时保守返回 false，避免调用方误以为包可下载。
 */
export async function checkSkillPackageExists(storageKey: string): Promise<boolean> {
  try {
    const bucket = getS3SkillSource();

    const { exists } = await bucket.client.checkObjectExists({
      key: storageKey
    });

    return exists ?? false;
  } catch {
    return false;
  }
}

/**
 * 复制 Skill 包到新版本位置。
 *
 * 优先确保源包已为 `.tar.gz`，并使用 S3 服务端 `copy`（写临时 TTL）实现 0 内存开销拷贝；
 * 若测试环境未提供 `bucket.copy`，回退到下载再上传。
 */
export async function copySkillPackage(
  sourceStorageKey: string,
  targetParams: Omit<UploadSkillPackageParams, 'zipBuffer'>
): Promise<SkillStorageInfo> {
  const resolvedSourceKey = await ensureTarGzSkillPackage({ storageKey: sourceStorageKey });
  const bucket = getS3SkillSource();

  if (typeof bucket.copy === 'function') {
    const key = getSkillPackageKey(targetParams);
    await bucket.copy({
      from: resolvedSourceKey,
      to: key,
      options: { temporary: true }
    });
    return { key };
  }

  const packageBuffer = await downloadSkillPackage({ storageKey: resolvedSourceKey });

  return uploadSkillPackage({
    ...targetParams,
    zipBuffer: packageBuffer
  });
}
