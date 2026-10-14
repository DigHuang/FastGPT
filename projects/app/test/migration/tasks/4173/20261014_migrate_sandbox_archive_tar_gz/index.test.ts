import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemMigrationContext } from '@/migration/registry';
import type {
  SystemMigrationFailedRecord,
  SystemMigrationProgressInput
} from '@fastgpt/global/migration/schema';
import { Types } from '@fastgpt/service/common/mongo';
import { MongoSandboxInstance } from '@fastgpt/service/core/ai/sandbox/infrastructure/instance/schema';
import { MongoAgentSkillsVersion } from '@fastgpt/service/core/ai/skill/version/schema';

const mocks = vi.hoisted(() => ({
  ensureTarGzWorkspaceArchive: vi.fn(),
  ensureTarGzSkillPackage: vi.fn()
}));

vi.mock('@/migration/constants', () => ({ systemMigrationBatchSize: 2 }));

vi.mock('@fastgpt/service/common/s3/sources/sandbox', () => ({
  getS3SandboxSource: () => ({
    ensureTarGzWorkspaceArchive: mocks.ensureTarGzWorkspaceArchive
  })
}));

vi.mock('@fastgpt/service/core/ai/skill/package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fastgpt/service/core/ai/skill/package')>()),
  ensureTarGzSkillPackage: mocks.ensureTarGzSkillPackage
}));

import { migrateSandboxArchiveTarGz } from '@/migration/tasks/4173/20261014_migrate_sandbox_archive_tar_gz';

const createContext = () => {
  let checkpoint: Record<string, unknown> | undefined;
  let failedRecords: SystemMigrationFailedRecord[] = [];
  const context = {
    migrationId: '20261014_migrate_sandbox_archive_tar_gz',
    runId: 'test-run',
    signal: new AbortController().signal,
    getCheckpoint: async (schema) =>
      checkpoint === undefined ? undefined : schema.parse(checkpoint),
    saveCheckpoint: vi.fn(async (value: Record<string, unknown>) => {
      checkpoint = structuredClone(value);
    }),
    assertActive: vi.fn(async () => undefined),
    reportProgress: vi.fn(async (_value: SystemMigrationProgressInput) => undefined),
    getFailedRecords: vi.fn(async () => failedRecords),
    reportFailedRecords: vi.fn(async (records: SystemMigrationFailedRecord[]) => {
      failedRecords = records;
    }),
    fail: vi.fn(async (input: { failedRecords?: SystemMigrationFailedRecord[] }) => {
      failedRecords = input.failedRecords ?? failedRecords;
      throw new Error('migration failed');
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  } satisfies SystemMigrationContext;
  return { context, getCheckpoint: () => checkpoint, getFailedRecords: () => failedRecords };
};

describe('migrateSandboxArchiveTarGz', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await MongoSandboxInstance.collection.deleteMany({});
    await MongoAgentSkillsVersion.collection.deleteMany({});
  });

  it('migrates archived sandbox instances and legacy .zip skill versions to .tar.gz', async () => {
    const sandboxDocId = new Types.ObjectId();
    await MongoSandboxInstance.collection.insertOne({
      _id: sandboxDocId,
      provider: 'opensandbox',
      sandboxId: 'sandbox-archived-1',
      sourceType: 'app',
      sourceId: String(new Types.ObjectId()),
      userId: 'user-1',
      status: 'archived',
      lastActiveAt: new Date(),
      createdAt: new Date()
    });

    const versionDocId = new Types.ObjectId();
    const oldKey = `agent-skills/team-1/skill-1/${String(versionDocId)}.zip`;
    const newKey = `agent-skills/team-1/skill-1/${String(versionDocId)}.tar.gz`;
    await MongoAgentSkillsVersion.collection.insertOne({
      _id: versionDocId,
      skillId: new Types.ObjectId(),
      tmbId: new Types.ObjectId(),
      storageKey: oldKey,
      createdAt: new Date()
    });

    mocks.ensureTarGzWorkspaceArchive.mockResolvedValue({
      key: 'sandbox/archive/sandbox-archived-1/package.tar.gz',
      migrated: true
    });
    mocks.ensureTarGzSkillPackage.mockImplementation(
      async ({ versionId }: { versionId: string }) => {
        await MongoAgentSkillsVersion.updateOne(
          { _id: versionId },
          { $set: { storageKey: newKey } }
        );
        return newKey;
      }
    );

    const { context } = createContext();
    await expect(migrateSandboxArchiveTarGz(context)).resolves.toEqual({
      sandboxScannedCount: 1,
      sandboxConvertedCount: 1,
      skillScannedCount: 1,
      skillConvertedCount: 1
    });

    expect(mocks.ensureTarGzWorkspaceArchive).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: 'sandbox-archived-1' })
    );
    expect(mocks.ensureTarGzSkillPackage).toHaveBeenCalledWith({
      versionId: String(versionDocId),
      storageKey: oldKey
    });
    const updatedVersion = await MongoAgentSkillsVersion.findById(versionDocId).lean();
    expect(updatedVersion?.storageKey).toBe(newKey);
    expect(context.fail).not.toHaveBeenCalled();
  });

  it('records failures and retries them on next run', async () => {
    const versionDocId = new Types.ObjectId();
    const oldKey = `agent-skills/team-1/skill-1/${String(versionDocId)}.zip`;
    const newKey = `agent-skills/team-1/skill-1/${String(versionDocId)}.tar.gz`;
    await MongoAgentSkillsVersion.collection.insertOne({
      _id: versionDocId,
      skillId: new Types.ObjectId(),
      tmbId: new Types.ObjectId(),
      storageKey: oldKey,
      createdAt: new Date()
    });

    mocks.ensureTarGzSkillPackage.mockRejectedValueOnce(new Error('S3 transient error'));

    const { context, getFailedRecords } = createContext();
    await expect(migrateSandboxArchiveTarGz(context)).rejects.toThrow('migration failed');
    expect(getFailedRecords()).toEqual([
      expect.objectContaining({
        stageKey: 'skill_packages',
        data: expect.objectContaining({
          recordType: 'skillVersion',
          recordId: String(versionDocId),
          storageKey: oldKey
        })
      })
    ]);

    mocks.ensureTarGzSkillPackage.mockImplementationOnce(async () => {
      await MongoAgentSkillsVersion.updateOne(
        { _id: versionDocId },
        { $set: { storageKey: newKey } }
      );
      return newKey;
    });

    await expect(migrateSandboxArchiveTarGz(context)).resolves.toMatchObject({
      skillConvertedCount: 1
    });
    expect(getFailedRecords()).toEqual([]);
  });
});
