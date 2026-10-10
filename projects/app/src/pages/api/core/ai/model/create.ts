import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import { resolveChannelType } from '@fastgpt/global/core/ai/model/utils';
import {
  CreateModelBodySchema,
  CreateModelResponseSchema,
  type CreateModelBody,
  type CreateModelResponse
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { createModel } from '@fastgpt/service/core/ai/model/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

async function handler(req: ApiRequestProps<CreateModelBody>): Promise<CreateModelResponse> {
  const { modelData, channelIds, channelType } = parseApiInput({
    req,
    bodySchema: CreateModelBodySchema
  }).body;
  const resolvedType = resolveChannelType({ channelType, scope: modelData.scope });

  const actor = await authUserPer({
    req,
    authToken: true,
    per: resolvedType === 'team' ? TeamModelCreatePermissionVal : undefined
  });
  if (resolvedType === 'system') {
    if (!actor.isRoot) throw ModelErrEnum.rootOnlyPermit;
  } else {
    await assertTeamModelEnabled();
  }
  const { tmbId, teamId } = actor;

  const createResult = await createModel({
    modelData,
    channelType: resolvedType,
    channelIds,
    tmbId,
    teamId
  });

  return CreateModelResponseSchema.parse(createResult);
}

export default NextAPI(handler);
