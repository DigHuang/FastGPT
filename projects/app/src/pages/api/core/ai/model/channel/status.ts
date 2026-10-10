import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  UpdateChannelStatusBodySchema,
  type UpdateChannelStatusBody
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateChannelStatus } from '@fastgpt/service/core/ai/model/channel/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 切换渠道启用/禁用状态 */
async function handler(req: ApiRequestProps<UpdateChannelStatusBody>): Promise<void> {
  const { id, status, channelType } = parseApiInput({
    req,
    bodySchema: UpdateChannelStatusBodySchema
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
  const { tmbId } = actor;

  await updateChannelStatus({ id, status, channelType, tmbId });
}

export default NextAPI(handler);
