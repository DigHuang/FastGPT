import { addHours } from 'date-fns';
import type { ClientSession } from 'mongoose';
import { Readable } from 'node:stream';
import { S3PrivateBucket } from '../../buckets/private';
import { MongoS3TTL } from '../../models/ttl';
import { removeS3TTL } from '../../utils';
import { encodeS3ObjectKey } from '../../keySanitizer';
import { type ArchiveStreamBody, uploadStreamPartsToS3 } from '../../utils/multipartStream';

const SKILL_PACKAGE_ROOT_PREFIX = 'agent-skills';

/**
 * 生成某个 Skill 在私有对象存储中的包前缀。
 *
 * 删除 Skill 时按这个前缀异步清理所有版本包；具体版本包使用 Mongo versionId 作为对象名，
 * 避免版本号重排或事务回滚导致 key 复用。
 */
export function getSkillPackagePrefix(params: { teamId: string; skillId: string }): string {
  const { teamId, skillId } = params;
  return `${encodeS3ObjectKey([SKILL_PACKAGE_ROOT_PREFIX, teamId, skillId].join('/'))}/`;
}

/**
 * 生成 Skill 版本包的私有对象存储 key（统一采用 `.tar.gz` 格式）。
 */
export function getSkillPackageKey(params: {
  teamId: string;
  skillId: string;
  packageObjectId: string;
}): string {
  const { teamId, skillId, packageObjectId } = params;
  return encodeS3ObjectKey(
    [SKILL_PACKAGE_ROOT_PREFIX, teamId, skillId, `${packageObjectId}.tar.gz`].join('/')
  );
}

/**
 * 生成旧版 `.zip` Skill 版本包的对象存储 key（仅供历史数据迁移与兼容检查使用）。
 */
export function getLegacySkillPackageKey(params: {
  teamId: string;
  skillId: string;
  packageObjectId: string;
}): string {
  const { teamId, skillId, packageObjectId } = params;
  return encodeS3ObjectKey(
    [SKILL_PACKAGE_ROOT_PREFIX, teamId, skillId, `${packageObjectId}.zip`].join('/')
  );
}

/** 将旧版 `.zip` storageKey 转换为对应的 `.tar.gz` storageKey。 */
export function toTarGzSkillStorageKey(storageKey: string): string {
  return storageKey.replace(/\.zip$/i, '.tar.gz');
}

export class S3SkillSource extends S3PrivateBucket {
  constructor() {
    super();
  }

  /**
   * 上传 Skill `.tar.gz` 版本包，并沿用通用 S3 上传封装写入临时 TTL。
   *
   * 调用方在 Mongo 事务提交 version/currentVersionId 时移除 TTL；事务失败时保留 TTL，
   * 由已有 S3 TTL cron 清理孤儿包。
   */
  async uploadPackage(params: {
    teamId: string;
    skillId: string;
    packageObjectId: string;
    body: ArchiveStreamBody;
    contentLength?: number;
    expiredTime?: Date;
    maxBytes?: number;
    createExceededError?: (limit: number) => Error;
  }) {
    const {
      teamId,
      skillId,
      packageObjectId,
      body,
      contentLength,
      expiredTime = addHours(new Date(), 1),
      maxBytes,
      createExceededError
    } = params;
    const key = getSkillPackageKey({ teamId, skillId, packageObjectId });

    if (
      Buffer.isBuffer(body) ||
      typeof body === 'string' ||
      (body instanceof Readable &&
        (contentLength !== undefined || typeof this.client?.createMultipartUpload !== 'function'))
    ) {
      return this.uploadFileByBody({
        key,
        body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
        contentLength,
        contentType: 'application/gzip',
        filename: 'package.tar.gz',
        expiredTime
      });
    }

    await MongoS3TTL.create({
      minioKey: key,
      bucketName: this.bucketName,
      expiredTime
    });

    await uploadStreamPartsToS3({
      client: this.client,
      key,
      body,
      contentType: 'application/gzip',
      filename: 'package.tar.gz',
      maxBytes,
      createExceededError
    });

    return {
      key
    };
  }

  /**
   * 按指定目标 key 直接流式上传 `.tar.gz` 版本包（不写入临时 TTL，用于存量 `.zip -> .tar.gz` 原位迁移）。
   */
  async uploadConfirmedTarGzByKey(params: {
    key: string;
    body: ArchiveStreamBody;
    maxBytes?: number;
  }) {
    await uploadStreamPartsToS3({
      client: this.client,
      key: params.key,
      body: params.body,
      contentType: 'application/gzip',
      filename: 'package.tar.gz',
      maxBytes: params.maxBytes
    });
    return { key: params.key };
  }

  deleteSkillPackagesByPrefix(params: { teamId: string; skillId: string }) {
    return this.addDeleteJob({
      prefix: getSkillPackagePrefix(params)
    });
  }

  removePackageTTL(key: string, session?: ClientSession) {
    return removeS3TTL({
      key,
      bucketName: 'private',
      session
    });
  }
}

export function getS3SkillSource() {
  if (global.skillBucket) {
    return global.skillBucket;
  }
  global.skillBucket = new S3SkillSource();
  return global.skillBucket;
}
