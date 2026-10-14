/**
 * 沙盒业务层：定义 Skill 版本包的 prepare step。
 *
 * 只服务 sandbox runtime 初始化链路，不负责 Skill 版本创建或权限校验。
 */
import type { SandboxStatusPhase } from '@fastgpt/global/core/chat/type';
import type { SandboxPrepareContext, SandboxPrepareStep } from '../prepare';
import { joinSandboxPath } from '../../../utils';
import { getAgentSandboxSkillMaxBytes } from '../../../config';
import {
  DEFAULT_GITIGNORE_CONTENT,
  downloadSkillPackageStream,
  ensureTarGzSkillPackage
} from '../../../../skill/package';
import { streamExtractTarGzIntoSandbox } from '../../streamArchive';

export type SkillPackagePrepareContext = SandboxPrepareContext & {
  workspaceHasContent?: boolean;
};

/** 将对象存储中的 skill `.tar.gz` 包通过 FIFO 流式写入 sandbox，并解压到当前工作目录。 */
export const deploySkillPackage =
  ({
    storageKey,
    skillsRootPath,
    onProgress
  }: {
    storageKey: string;
    skillsRootPath: string;
    onProgress?: (phase: SandboxStatusPhase) => void;
  }): SandboxPrepareStep<SkillPackagePrepareContext> =>
  async (context) => {
    await context.sandbox.createDirectories([skillsRootPath]);

    const maxPackageBytes = getAgentSandboxSkillMaxBytes();

    onProgress?.('downloadingPackage');
    const resolvedStorageKey = await ensureTarGzSkillPackage({ storageKey });
    const packageStream = await downloadSkillPackageStream({ storageKey: resolvedStorageKey });
    onProgress?.('uploadingPackage');
    onProgress?.('extractingPackage');

    await streamExtractTarGzIntoSandbox({
      sandbox: context.sandbox,
      targetDirectory: context.workDirectory,
      archiveStream: packageStream,
      maxUncompressedBytes: maxPackageBytes,
      clearTargetDirectory: false
    });

    const gitignorePath = joinSandboxPath(context.workDirectory, '.gitignore');
    const gitignoreInfo = await context.sandbox.getFileInfo([gitignorePath]);
    if (!gitignoreInfo.get(gitignorePath)?.isFile) {
      const [writeGitignoreResult] = await context.sandbox.writeFiles([
        { path: gitignorePath, data: DEFAULT_GITIGNORE_CONTENT }
      ]);
      if (writeGitignoreResult?.error) {
        throw new Error(
          `Failed to write default .gitignore: ${writeGitignoreResult.error.message}`
        );
      }
    }

    return context;
  };
