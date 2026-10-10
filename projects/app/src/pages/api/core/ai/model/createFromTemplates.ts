import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  CreateModelsFromTemplatesBodySchema,
  CreateModelsFromTemplatesResponseSchema,
  type CreateModelsFromTemplatesBody,
  type CreateModelsFromTemplatesResponse
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { createModelsFromTemplates } from '@fastgpt/service/core/ai/model/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

async function handler(
  req: ApiRequestProps<CreateModelsFromTemplatesBody>
): Promise<CreateModelsFromTemplatesResponse> {
  const { templates, channelType, channelIds } = parseApiInput({
    req,
    bodySchema: CreateModelsFromTemplatesBodySchema
  }).body;

  const actor = await authUserPer({
    req,
    authToken: true,
    per: channelType === 'team' ? TeamModelCreatePermissionVal : undefined
  });
  if (channelType === 'system') {
    if (!actor.isRoot) throw ModelErrEnum.rootOnlyPermit;
  } else {
    await assertTeamModelEnabled();
  }
  const { tmbId, teamId } = actor;

  const result = await createModelsFromTemplates({
    templates,
    channelIds,
    channelType,
    tmbId: channelType === 'team' ? tmbId : undefined,
    teamId: channelType === 'team' ? teamId : undefined
  });

  return CreateModelsFromTemplatesResponseSchema.parse(result);
}

export default NextAPI(handler);
