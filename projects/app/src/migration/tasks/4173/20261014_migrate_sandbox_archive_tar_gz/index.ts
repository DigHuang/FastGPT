import { z } from 'zod';
import { SystemMigrationStatusEnum } from '@fastgpt/global/migration/constants';
import type { SystemMigrationFailedRecord } from '@fastgpt/global/migration/schema';
import { batchRun } from '@fastgpt/global/common/system/utils';
import { getErrText } from '@fastgpt/global/common/error/utils';
import { MongoSandboxInstance } from '@fastgpt/service/core/ai/sandbox/infrastructure/instance/schema';
import { getS3SandboxSource } from '@fastgpt/service/common/s3/sources/sandbox';
import { getAgentSandboxArchiveMaxBytes } from '@fastgpt/service/core/ai/sandbox/config';
import { MongoAgentSkillsVersion } from '@fastgpt/service/core/ai/skill/version/schema';
import { ensureTarGzSkillPackage } from '@fastgpt/service/core/ai/skill/package';
import { systemMigrationBatchSize } from '@/migration/constants';
import type { SystemMigrationContext } from '@/migration/registry';

const ARCHIVE_MIGRATION_CONCURRENCY = 5;

const CursorSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/)
  .nullable();

const CheckpointSchema = z.object({
  version: z.literal(1),
  stage: z.enum(['sandbox_archives', 'skill_packages', 'validation']),
  lastSandboxId: CursorSchema,
  lastSkillVersionId: CursorSchema,
  sandboxScannedCount: z.number().int().nonnegative(),
  sandboxConvertedCount: z.number().int().nonnegative(),
  skillScannedCount: z.number().int().nonnegative(),
  skillConvertedCount: z.number().int().nonnegative()
});

type SandboxArchiveCandidate = {
  _id: string;
  sandboxId: string;
};

type SkillVersionCandidate = {
  _id: string;
  storageKey: string;
};

const readSandboxArchiveBatch = async (params: {
  lastId: string | null;
  limit: number;
}): Promise<SandboxArchiveCandidate[]> => {
  const docs = await MongoSandboxInstance.find(
    {
      status: { $in: ['archived', 'restoring'] },
      ...(params.lastId ? { _id: { $gt: params.lastId } } : {})
    },
    { _id: 1, sandboxId: 1 }
  )
    .sort({ _id: 1 })
    .limit(params.limit)
    .lean();

  return docs.map((doc) => ({
    _id: String(doc._id),
    sandboxId: doc.sandboxId
  }));
};

const readSkillVersionZipBatch = async (params: {
  lastId: string | null;
  limit: number;
}): Promise<SkillVersionCandidate[]> => {
  const docs = await MongoAgentSkillsVersion.find(
    {
      storageKey: { $regex: /\.zip$/i },
      ...(params.lastId ? { _id: { $gt: params.lastId } } : {})
    },
    { _id: 1, storageKey: 1 }
  )
    .sort({ _id: 1 })
    .limit(params.limit)
    .lean();

  return docs.map((doc) => ({
    _id: String(doc._id),
    storageKey: doc.storageKey
  }));
};

/**
 * 4.17.3 系统自动迁移任务：将存量 Sandbox 冷归档 `package.zip` 与 Skill 版本包 `*.zip`
 * 批量通过 `yauzl` 流式转换为 `.tar.gz` 并清理旧 `.zip`。
 *
 * 与运行期按需懒迁移（`ensureTarGzWorkspaceArchive` / `ensureTarGzSkillPackage`）共享同一套幂等原子转换逻辑，
 * 互不冲突；因此作为非阻塞自动任务在后台执行。
 */
export const migrateSandboxArchiveTarGz = async (context: SystemMigrationContext) => {
  await context.assertActive();

  let checkpoint = await context.getCheckpoint(CheckpointSchema);
  if (!checkpoint) {
    checkpoint = {
      version: 1,
      stage: 'sandbox_archives',
      lastSandboxId: null,
      lastSkillVersionId: null,
      sandboxScannedCount: 0,
      sandboxConvertedCount: 0,
      skillScannedCount: 0,
      skillConvertedCount: 0
    };
    await context.saveCheckpoint(checkpoint);
  }

  const failedRecordMap = new Map<string, SystemMigrationFailedRecord>(
    (await context.getFailedRecords()).map((record) => [
      `${String(record.data.recordType ?? 'unknown')}:${String(record.data.recordId)}`,
      record
    ])
  );

  const persistFailedRecords = async () => {
    await context.reportFailedRecords([...failedRecordMap.values()]);
  };

  const migrateSingleSandboxArchive = async (
    candidate: SandboxArchiveCandidate
  ): Promise<boolean> => {
    const mapKey = `sandbox:${candidate._id}`;
    try {
      const s3Sandbox = getS3SandboxSource();
      const maxBytes = getAgentSandboxArchiveMaxBytes();
      const result = await s3Sandbox.ensureTarGzWorkspaceArchive({
        sandboxId: candidate.sandboxId,
        maxBytes
      });
      failedRecordMap.delete(mapKey);
      return result.migrated;
    } catch (error) {
      failedRecordMap.set(mapKey, {
        stageKey: 'sandbox_archives',
        data: {
          recordType: 'sandbox',
          recordId: candidate._id,
          sandboxId: candidate.sandboxId
        },
        reason: {
          message: getErrText(error)
        }
      });
      return false;
    }
  };

  const migrateSingleSkillVersion = async (candidate: SkillVersionCandidate): Promise<boolean> => {
    const mapKey = `skillVersion:${candidate._id}`;
    try {
      const newKey = await ensureTarGzSkillPackage({
        versionId: candidate._id,
        storageKey: candidate.storageKey
      });
      failedRecordMap.delete(mapKey);
      return newKey !== candidate.storageKey;
    } catch (error) {
      failedRecordMap.set(mapKey, {
        stageKey: 'skill_packages',
        data: {
          recordType: 'skillVersion',
          recordId: candidate._id,
          storageKey: candidate.storageKey
        },
        reason: {
          message: getErrText(error)
        }
      });
      return false;
    }
  };

  // 先重试上次失败的记录
  const previousFailures = [...failedRecordMap.values()];
  if (previousFailures.length > 0) {
    await context.assertActive();
    for (const failed of previousFailures) {
      const recordType = String(failed.data.recordType ?? '');
      const recordId = String(failed.data.recordId ?? '');
      if (recordType === 'sandbox') {
        const doc = await MongoSandboxInstance.findById(recordId, {
          _id: 1,
          sandboxId: 1,
          status: 1
        }).lean();
        if (!doc || (doc.status !== 'archived' && doc.status !== 'restoring')) {
          failedRecordMap.delete(`sandbox:${recordId}`);
          continue;
        }
        const converted = await migrateSingleSandboxArchive({
          _id: String(doc._id),
          sandboxId: doc.sandboxId
        });
        if (converted) {
          checkpoint = {
            ...checkpoint,
            sandboxConvertedCount: checkpoint.sandboxConvertedCount + 1
          };
        }
      } else if (recordType === 'skillVersion') {
        const doc = await MongoAgentSkillsVersion.findById(recordId, {
          _id: 1,
          storageKey: 1
        }).lean();
        if (!doc || !doc.storageKey?.toLowerCase().endsWith('.zip')) {
          failedRecordMap.delete(`skillVersion:${recordId}`);
          continue;
        }
        const converted = await migrateSingleSkillVersion({
          _id: String(doc._id),
          storageKey: doc.storageKey
        });
        if (converted) {
          checkpoint = {
            ...checkpoint,
            skillConvertedCount: checkpoint.skillConvertedCount + 1
          };
        }
      }
    }
    await persistFailedRecords();
    await context.saveCheckpoint(checkpoint);
  }

  // 阶段 1：迁移 Sandbox 冷归档 package.zip -> package.tar.gz
  if (checkpoint.stage === 'sandbox_archives') {
    await context.reportProgress({
      key: 'sandbox_archives',
      status: SystemMigrationStatusEnum.running,
      current: checkpoint.sandboxScannedCount
    });

    while (true) {
      context.signal.throwIfAborted();
      await context.assertActive();

      const batch = await readSandboxArchiveBatch({
        lastId: checkpoint.lastSandboxId,
        limit: systemMigrationBatchSize
      });
      if (batch.length === 0) break;

      const convertedFlags = await batchRun(
        batch,
        (candidate) => migrateSingleSandboxArchive(candidate),
        ARCHIVE_MIGRATION_CONCURRENCY
      );
      const convertedInBatch = convertedFlags.filter(Boolean).length;

      await persistFailedRecords();
      await context.assertActive();

      checkpoint = {
        ...checkpoint,
        lastSandboxId: batch.at(-1)!._id,
        sandboxScannedCount: checkpoint.sandboxScannedCount + batch.length,
        sandboxConvertedCount: checkpoint.sandboxConvertedCount + convertedInBatch
      };
      await context.saveCheckpoint(checkpoint);
      await context.reportProgress({
        key: 'sandbox_archives',
        status: SystemMigrationStatusEnum.running,
        current: checkpoint.sandboxScannedCount
      });
    }

    checkpoint = {
      ...checkpoint,
      stage: 'skill_packages'
    };
    await context.saveCheckpoint(checkpoint);
  }

  await context.reportProgress({
    key: 'sandbox_archives',
    status: SystemMigrationStatusEnum.succeeded,
    current: checkpoint.sandboxScannedCount
  });

  // 阶段 2：迁移 Skill 版本包 *.zip -> *.tar.gz
  if (checkpoint.stage === 'skill_packages') {
    await context.reportProgress({
      key: 'skill_packages',
      status: SystemMigrationStatusEnum.running,
      current: checkpoint.skillScannedCount
    });

    while (true) {
      context.signal.throwIfAborted();
      await context.assertActive();

      const batch = await readSkillVersionZipBatch({
        lastId: checkpoint.lastSkillVersionId,
        limit: systemMigrationBatchSize
      });
      if (batch.length === 0) break;

      const convertedFlags = await batchRun(
        batch,
        (candidate) => migrateSingleSkillVersion(candidate),
        ARCHIVE_MIGRATION_CONCURRENCY
      );
      const convertedInBatch = convertedFlags.filter(Boolean).length;

      await persistFailedRecords();
      await context.assertActive();

      checkpoint = {
        ...checkpoint,
        lastSkillVersionId: batch.at(-1)!._id,
        skillScannedCount: checkpoint.skillScannedCount + batch.length,
        skillConvertedCount: checkpoint.skillConvertedCount + convertedInBatch
      };
      await context.saveCheckpoint(checkpoint);
      await context.reportProgress({
        key: 'skill_packages',
        status: SystemMigrationStatusEnum.running,
        current: checkpoint.skillScannedCount
      });
    }

    checkpoint = {
      ...checkpoint,
      stage: 'validation'
    };
    await context.saveCheckpoint(checkpoint);
  }

  await context.reportProgress({
    key: 'skill_packages',
    status: SystemMigrationStatusEnum.succeeded,
    current: checkpoint.skillScannedCount
  });

  // 阶段 3：校验是否仍有遗漏的 .zip Skill 版本或未解决失败项
  await context.reportProgress({
    key: 'validation',
    status: SystemMigrationStatusEnum.running
  });
  await context.assertActive();

  const remainingZipVersions = await readSkillVersionZipBatch({
    lastId: null,
    limit: systemMigrationBatchSize
  });
  for (const remaining of remainingZipVersions) {
    const mapKey = `skillVersion:${remaining._id}`;
    if (!failedRecordMap.has(mapKey)) {
      failedRecordMap.set(mapKey, {
        stageKey: 'validation',
        data: {
          recordType: 'skillVersion',
          recordId: remaining._id,
          storageKey: remaining.storageKey
        },
        reason: {
          message: 'Skill version storageKey still ends with .zip after migration'
        }
      });
    }
  }

  if (failedRecordMap.size > 0) {
    await persistFailedRecords();
    checkpoint = {
      ...checkpoint,
      stage: 'sandbox_archives',
      lastSandboxId: null,
      lastSkillVersionId: null
    };
    await context.saveCheckpoint(checkpoint);
    await context.fail({
      message: `${failedRecordMap.size} sandbox or skill archives failed to migrate to .tar.gz`,
      failedRecords: [...failedRecordMap.values()]
    });
  }

  const result = {
    sandboxScannedCount: checkpoint.sandboxScannedCount,
    sandboxConvertedCount: checkpoint.sandboxConvertedCount,
    skillScannedCount: checkpoint.skillScannedCount,
    skillConvertedCount: checkpoint.skillConvertedCount
  };
  context.logger.info('Sandbox and Skill .tar.gz archive migration completed', result);
  await context.reportProgress({
    key: 'validation',
    status: SystemMigrationStatusEnum.succeeded
  });
  return result;
};
