import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  ChannelModelsResponseSchema,
  GetChannelModelsQuerySchema,
  type ChannelModelsResponse,
  type GetChannelModelsQuery
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { getChannelModels } from '@fastgpt/service/core/ai/model/channel/association';
import { resolveChannelForOperation } from '@fastgpt/service/core/ai/model/channel/resolve';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 查询指定渠道在其桶内关联的所有模型清单 */
async function handler(
  req: ApiRequestProps<Record<string, never>, GetChannelModelsQuery>
): Promise<ChannelModelsResponse> {
  const { id, channelType } = parseApiInput({
    req,
    querySchema: GetChannelModelsQuerySchema
  }).query;

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
  const resolved = await resolveChannelForOperation({ id, channelType, tmbId });
  const models = await getChannelModels(resolved.channel, teamId);

  return ChannelModelsResponseSchema.parse({ models });
}

export default NextAPI(handler);
