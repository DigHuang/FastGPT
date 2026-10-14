import { AgentSkillSourceEnum, AgentSkillTypeEnum } from '@fastgpt/global/core/ai/skill/constants';
import { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type {
  RuntimeSkillMetadataType,
  SkillPackageType
} from '@fastgpt/global/core/ai/skill/type';
import { Types } from '../../../../common/mongo';
import { mongoSessionRun } from '../../../../common/mongo/sessionRun';
import { removeSkillPackageTTL, uploadSkillPackageStream } from '../package';
import { MongoAgentSkills } from '../model/schema';
import { createVersion } from '../version';
import { updateCurrentVersion } from './update';
import type { Readable } from 'node:stream';
import { createResourcePermissions } from '../../../../support/permission/resourcePermissionService';
import { convertZipStreamToTarGzStream } from '../../../../common/file/archive/tarGz';
import { getAgentSandboxSkillMaxBytes } from '../../sandbox/config';
import { SkillErrEnum } from '@fastgpt/global/common/error/code/skill';
import { getErrText } from '@fastgpt/global/common/error/utils';

type ImportSkillParams = {
  skill: SkillPackageType['skill'];
  teamId: string;
  tmbId: string;
  packageStream: Readable;
  contentLength?: number;
  parentId?: string | null;
};

const mapImportArchiveError = (error: unknown): unknown => {
  const errText = getErrText(error);
  const lowerText = errText.toLowerCase();
  if (
    error === SkillErrEnum.archiveTooLarge ||
    errText === SkillErrEnum.archiveTooLarge ||
    lowerText.includes('exceeds maximum allowed')
  ) {
    return SkillErrEnum.archiveTooLarge;
  }
  if (
    lowerText.includes('end of central directory') ||
    lowerText.includes('failed to open zip') ||
    lowerText.includes('unsafe archive entry') ||
    lowerText.includes('unsupported special file') ||
    lowerText.includes('symlink') ||
    lowerText.includes('zip entry size mismatch') ||
    lowerText.includes('invalid')
  ) {
    return SkillErrEnum.invalidArchiveFormat;
  }
  return error;
};

/**
 * Import a browser-uploaded `.zip` package stream as the initial Skill version in `.tar.gz` format.
 *
 * This function streams the `.zip` into `convertZipStreamToTarGzStream` (`yauzl` lazy streaming ->
 * `.tar.gz`), uploads the resulting `.tar.gz` stream to S3 before opening the Mongo transaction,
 * then creates the default ACL, binds currentVersionId, and removes the temporary S3 TTL inside the
 * transaction. If Mongo fails, the uploaded package keeps its TTL and is cleaned by the shared S3
 * cleanup flow. Runtime metadata remains empty until the workspace is saved and deployed from the
 * edit sandbox.
 */
export async function importSkill({
  skill,
  teamId,
  tmbId,
  packageStream,
  parentId
}: ImportSkillParams): Promise<string> {
  const runtimeSkills: RuntimeSkillMetadataType[] = [];

  const newSkill = new MongoAgentSkills({
    parentId: parentId ?? null,
    type: AgentSkillTypeEnum.skill,
    source: AgentSkillSourceEnum.personal,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    avatar: skill.avatar,
    teamId,
    tmbId,
    createTime: new Date(),
    updateTime: new Date()
  });

  const newSkillId = newSkill._id.toString();
  const versionId = new Types.ObjectId().toString();
  const maxBytes = getAgentSandboxSkillMaxBytes();

  let storageInfo;
  try {
    const tarGzStream = await convertZipStreamToTarGzStream({
      zipStream: packageStream,
      maxCompressedBytes: maxBytes,
      options: {
        maxUncompressedBytes: maxBytes
      }
    });

    storageInfo = await uploadSkillPackageStream({
      teamId,
      skillId: newSkillId,
      packageObjectId: versionId,
      packageStream: tarGzStream
    });
  } catch (error) {
    return Promise.reject(mapImportArchiveError(error));
  }

  return mongoSessionRun(async (session) => {
    await newSkill.save({ session });

    await createResourcePermissions({
      resource: {
        _id: newSkillId,
        type: AgentSkillTypeEnum.skill,
        teamId,
        ...(parentId ? { parentId } : {})
      },
      tmbId,
      resourceType: PerResourceTypeEnum.agentSkill,
      session
    });

    await updateCurrentVersion({
      skillId: newSkillId,
      currentVersionId: versionId,
      runtimeSkills,
      session
    });

    await createVersion(
      {
        versionId,
        skillId: newSkillId,
        tmbId,
        versionName: 'Initial import',
        storageKey: storageInfo.key,
        runtimeSkills
      },
      session
    );
    await removeSkillPackageTTL(storageInfo.key, session);

    return newSkillId;
  });
}
