import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  AffectedModelsResponseSchema,
  GetAffectedModelsQuerySchema,
  type AffectedModelsResponse,
  type GetAffectedModelsQuery
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  getBatchChannelsAffectedModels,
  getChannelAffectedModels
} from '@fastgpt/service/core/ai/model/channel/association';
import { resolveChannelsForOperation } from '@fastgpt/service/core/ai/model/channel/resolve';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 渠道删除影响预查：返回仅依赖该渠道（或该批渠道）的模型清单 */
async function handler(
  req: ApiRequestProps<Record<string, never>, GetAffectedModelsQuery>
): Promise<AffectedModelsResponse> {
  const { ids, channelType } = parseApiInput({
    req,
    querySchema: GetAffectedModelsQuerySchema
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
  const resolved = await resolveChannelsForOperation({
    ids,
    channelType,
    tmbId
  });
  const affectedModels =
    ids.length === 1
      ? await getChannelAffectedModels(resolved[0].channel, teamId)
      : await getBatchChannelsAffectedModels(
          resolved.map((r) => r.channel),
          teamId
        );

  return AffectedModelsResponseSchema.parse({ affectedModels });
}

export default NextAPI(handler);
