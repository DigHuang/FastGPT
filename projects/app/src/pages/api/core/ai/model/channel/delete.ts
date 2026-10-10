import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  DeleteChannelQuerySchema,
  DeleteChannelResponseSchema,
  type DeleteChannelQuery,
  type DeleteChannelResponse
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { deleteChannel } from '@fastgpt/service/core/ai/model/channel/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 删除渠道：删除前计算并返回受影响的模型清单 */
async function handler(
  req: ApiRequestProps<Record<string, never>, DeleteChannelQuery>
): Promise<DeleteChannelResponse> {
  const { id, channelType } = parseApiInput({
    req,
    querySchema: DeleteChannelQuerySchema
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

  return DeleteChannelResponseSchema.parse(await deleteChannel({ id, channelType, tmbId, teamId }));
}

export default NextAPI(handler);
