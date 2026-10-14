import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from '@fastgpt/service/common/mongo';
import { MongoAgentSkills } from '@fastgpt/service/core/ai/skill/model/schema';
import { MongoAgentSkillsVersion } from '@fastgpt/service/core/ai/skill/version/schema';
import { importSkill } from '@fastgpt/service/core/ai/skill/manage';
import { deleteSkillPackage } from '@fastgpt/service/core/ai/skill/package';
import {
  getSkillEditRuntimeContext,
  getSkillEditRuntimeStatus,
  initSkillEditRuntimeSandbox,
  packageSkillInSandbox,
  streamSkillEditWorkspace
} from '@fastgpt/service/core/ai/sandbox/application/skillEdit/runtime';
import {
  EDIT_DEBUG_SANDBOX_CHAT_ID,
  getEditDebugSandboxId
} from '@fastgpt/service/core/ai/skill/edit/config';
import { getRunningSandboxClient } from '@fastgpt/service/core/ai/sandbox/application/runtime/client';
import { streamDirectoryZipFromSandbox } from '@fastgpt/service/core/ai/sandbox/application/file';
import { joinSandboxPath } from '@fastgpt/service/core/ai/sandbox/utils';
import { deleteSandboxResource } from '@fastgpt/service/core/ai/sandbox/application/resource';
import { MongoSandboxInstance } from '@fastgpt/service/core/ai/sandbox/infrastructure/instance/schema';
import { ChatSourceTypeEnum } from '@fastgpt/global/core/chat/constants';
import {
  isGzipBuffer,
  isZipBuffer,
  parseTarGzEntries
} from '@fastgpt/service/common/file/archive/tarGz';
import { getSandboxIntegrationProvider } from './config';

const integrationProvider = getSandboxIntegrationProvider();

/** 创建一个真实导入包，故意不写入根目录 `.gitignore`。 */
const createImportedSkillPackage = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('SKILL.md', '# Imported skill\n\nThis package intentionally has no gitignore.\n');
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe.skipIf(!integrationProvider).sequential('Skill import Sandbox Integration', () => {
  const originalFeConfigs = global.feConfigs;
  const originalSandboxBucket = global.sandboxBucket;
  const originalSkillBucket = global.skillBucket;
  const cleanupArchive = vi.fn(async () => undefined);

  afterEach(async () => {
    global.feConfigs = originalFeConfigs;
    global.sandboxBucket = originalSandboxBucket;
    global.skillBucket = originalSkillBucket;
  });

  it('creates the Skill Edit sandbox for an imported package without .gitignore and streams pack/export/download', async () => {
    global.feConfigs = {
      ...(originalFeConfigs ?? {}),
      show_agent_sandbox: true
    } as typeof global.feConfigs;
    global.sandboxBucket = {
      deleteWorkspaceArchiveNow: cleanupArchive
    } as unknown as typeof global.sandboxBucket;

    const teamId = new Types.ObjectId().toString();
    const tmbId = new Types.ObjectId().toString();
    const packageBuffer = await createImportedSkillPackage();
    const importedZip = await JSZip.loadAsync(packageBuffer);
    expect(importedZip.file('.gitignore')).toBeNull();
    let storedPackage: Buffer | undefined;
    global.skillBucket = {
      uploadPackage: vi.fn(
        async ({
          teamId: uploadTeamId,
          skillId: uploadSkillId,
          packageObjectId,
          body
        }: {
          teamId: string;
          skillId: string;
          packageObjectId: string;
          body: Buffer | Readable;
        }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of Readable.from(body)) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          storedPackage = Buffer.concat(chunks);
          expect(isGzipBuffer(storedPackage)).toBe(true);
          return {
            key: `agent-skills/${uploadTeamId}/${uploadSkillId}/${packageObjectId}.tar.gz`
          };
        }
      ),
      removePackageTTL: vi.fn(async () => undefined),
      client: {
        downloadObject: vi.fn(async () => ({
          body: Readable.from([storedPackage])
        })),
        deleteObject: vi.fn(async () => undefined),
        checkObjectExists: vi.fn(async () => ({ exists: true }))
      }
    } as unknown as typeof global.skillBucket;

    const skillId = await importSkill({
      skill: {
        name: `Imported skill ${randomUUID()}`,
        description: 'Skill import sandbox integration',
        category: []
      },
      teamId,
      tmbId,
      packageStream: Readable.from(packageBuffer),
      contentLength: packageBuffer.length
    });

    const skillVersion = await MongoAgentSkillsVersion.findOne({ skillId }).lean();
    if (!skillVersion) throw new Error(`Imported skill version not found: ${skillId}`);

    const sandboxId = getEditDebugSandboxId(skillId);
    let sandboxClient: Awaited<ReturnType<typeof getRunningSandboxClient>> | undefined;

    try {
      const context = await getSkillEditRuntimeContext({ skillId, teamId });
      await expect(getSkillEditRuntimeStatus({ context })).resolves.toMatchObject({
        status: 'readyToInit'
      });

      await initSkillEditRuntimeSandbox({ context });

      sandboxClient = await getRunningSandboxClient({
        sandboxId,
        sourceType: ChatSourceTypeEnum.skillEdit,
        sourceId: skillId,
        userId: ChatSourceTypeEnum.skillEdit,
        chatId: EDIT_DEBUG_SANDBOX_CHAT_ID
      });

      const workDirectory = context.runtimeProfile.workDirectory;
      const [gitignore, skillMd] = await sandboxClient.provider.readFiles([
        joinSandboxPath(workDirectory, '.gitignore'),
        joinSandboxPath(workDirectory, 'SKILL.md')
      ]);

      expect(gitignore?.error).toBeNull();
      expect(Buffer.from(gitignore?.content ?? []).toString()).toContain('node_modules');
      expect(skillMd?.error).toBeNull();

      // 写入合法 SKILL.md frontmatter 与测试脚本，验证容器内流式打包 (.tar.gz) 与导出/目录下载 (.zip)
      await sandboxClient.provider.writeFiles([
        {
          path: joinSandboxPath(workDirectory, 'SKILL.md'),
          data: '---\nname: IntegrationSkill\ndescription: Streaming integration test\n---\n# IntegrationSkill\n'
        },
        {
          path: joinSandboxPath(workDirectory, 'helper.txt'),
          data: 'hello-streaming-archive'
        }
      ]);

      const packedTarGz = await packageSkillInSandbox({
        sandboxId,
        validationMode: 'deployableSkill'
      });
      expect(isGzipBuffer(packedTarGz)).toBe(true);
      const tarEntries = await parseTarGzEntries(packedTarGz);
      expect(tarEntries.map((e) => e.path)).toEqual(
        expect.arrayContaining(['SKILL.md', 'helper.txt'])
      );

      // 验证导出工作区流式返回 .zip
      const exportZipChunks: Buffer[] = [];
      for await (const chunk of await streamSkillEditWorkspace({
        skillId,
        teamId,
        format: 'zip'
      })) {
        exportZipChunks.push(Buffer.from(chunk));
      }
      const exportedZipBuffer = Buffer.concat(exportZipChunks);
      expect(isZipBuffer(exportedZipBuffer)).toBe(true);
      const exportedZip = await JSZip.loadAsync(exportedZipBuffer);
      expect(await exportedZip.file('helper.txt')?.async('string')).toBe('hello-streaming-archive');

      // 验证任意目录流式下载返回 .zip
      const dirZipChunks: Buffer[] = [];
      for await (const chunk of streamDirectoryZipFromSandbox({
        sandbox: sandboxClient,
        path: workDirectory
      })) {
        dirZipChunks.push(Buffer.from(chunk));
      }
      const dirZipBuffer = Buffer.concat(dirZipChunks);
      expect(isZipBuffer(dirZipBuffer)).toBe(true);

      // 验证容器 /tmp 下无任何残留临时打包或解包目录
      const leftoverCheck = await sandboxClient.provider.execute(
        'find /tmp -maxdepth 1 -name ".fastgpt-*" 2>/dev/null'
      );
      expect(leftoverCheck.stdout.trim()).toBe('');
    } finally {
      await sandboxClient?.provider.close().catch(() => undefined);

      const sandboxInstance = await MongoSandboxInstance.findOne({ sandboxId }).lean();
      if (sandboxInstance) {
        await deleteSandboxResource(sandboxInstance);
      }
      await deleteSkillPackage(skillVersion.storageKey);
      await MongoAgentSkillsVersion.deleteMany({ skillId });
      await MongoAgentSkills.deleteOne({ _id: skillId });
    }

    expect(cleanupArchive).toHaveBeenCalledWith({ sandboxId });
  });
});
