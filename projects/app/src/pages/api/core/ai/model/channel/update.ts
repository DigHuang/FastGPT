import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  UpdateChannelBodySchema,
  type UpdateChannelBody
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateChannel } from '@fastgpt/service/core/ai/model/channel/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 更新渠道配置 */
async function handler(req: ApiRequestProps<UpdateChannelBody>): Promise<void> {
  const body = parseApiInput({ req, bodySchema: UpdateChannelBodySchema }).body;
  const { id, channelType, ...patch } = body;

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
  await updateChannel({ id, channelType, tmbId, channelData: patch });
}

export default NextAPI(handler);
