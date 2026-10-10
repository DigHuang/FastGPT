import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  BatchChannelBodySchema,
  BatchDeleteChannelsResponseSchema,
  type BatchChannelBody,
  type BatchChannelResponse
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { batchOperateChannels } from '@fastgpt/service/core/ai/model/channel/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 批量操作渠道（批量删除 / 批量启用停用） */
async function handler(req: ApiRequestProps<BatchChannelBody>): Promise<BatchChannelResponse> {
  const body = parseApiInput({ req, bodySchema: BatchChannelBodySchema }).body;
  const { channelType, action } = body;

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

  const result = await batchOperateChannels({ body, tmbId, teamId });
  return action === 'delete'
    ? BatchDeleteChannelsResponseSchema.parse({ affectedModels: result.affectedModels })
    : undefined;
}

export default NextAPI(handler);
