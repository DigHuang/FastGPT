import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  ListChannelsQuerySchema,
  ListChannelsResponseSchema,
  type ListChannelsQuery,
  type ListChannelsResponse
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  getMemberChannelList,
  getSystemChannelList
} from '@fastgpt/service/core/ai/model/channel/list';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 查询渠道列表：root 可查看系统渠道或私有渠道，成员查看私有渠道 */
async function handler(
  req: ApiRequestProps<Record<string, never>, ListChannelsQuery>
): Promise<ListChannelsResponse> {
  const { pageNum, pageSize, channelType, search } = parseApiInput({
    req,
    querySchema: ListChannelsQuerySchema
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

  if (channelType === 'system') {
    return ListChannelsResponseSchema.parse(
      await getSystemChannelList({ pageNum, pageSize, search })
    );
  }
  return ListChannelsResponseSchema.parse(
    await getMemberChannelList({ teamId, tmbId, pageNum, pageSize, search })
  );
}

export default NextAPI(handler);
