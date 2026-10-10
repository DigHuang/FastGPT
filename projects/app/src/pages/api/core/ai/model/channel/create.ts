import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  CreateChannelBodySchema,
  CreateChannelResponseSchema,
  type CreateChannelBody,
  type CreateChannelResponse
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { createChannel } from '@fastgpt/service/core/ai/model/channel/service';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 创建渠道：root 创建系统渠道，成员创建私有团队分组渠道 */
async function handler(req: ApiRequestProps<CreateChannelBody>): Promise<CreateChannelResponse> {
  const body = parseApiInput({ req, bodySchema: CreateChannelBodySchema }).body;
  const { channelType, ...channelData } = body;

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

  return CreateChannelResponseSchema.parse(
    await createChannel({ channelType, tmbId, channelData })
  );
}

export default NextAPI(handler);
