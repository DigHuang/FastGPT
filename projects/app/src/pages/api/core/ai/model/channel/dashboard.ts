import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  GetChannelDashboardQuerySchema,
  GetChannelDashboardResponseSchema,
  type GetChannelDashboardQuery,
  type GetChannelDashboardResponse
} from '@fastgpt/global/openapi/core/ai/model/channel/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { getChannelDashboard } from '@fastgpt/service/core/ai/model/channel/observability';
import { resolveChannelObservabilityScope } from '@fastgpt/service/core/ai/model/channel/resolve';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/**
 * 查询当前登录成员可访问范围内的渠道监控数据。
 * channelId 会在请求 aiproxy 前按 system/当前成员 group bucket 校验归属。
 */
async function handler(
  req: ApiRequestProps<Record<string, never>, GetChannelDashboardQuery>
): Promise<GetChannelDashboardResponse> {
  const query = parseApiInput({ req, querySchema: GetChannelDashboardQuerySchema }).query;
  const { channelType, channelId, ...filters } = query;
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
  const { tmbId, isRoot } = actor;
  const { groupId } = await resolveChannelObservabilityScope({
    channelType,
    channelId,
    tmbId,
    isRoot
  });

  const result = await getChannelDashboard({ ...filters, channelId, groupId });
  return GetChannelDashboardResponseSchema.parse(result);
}

export default NextAPI(handler);
