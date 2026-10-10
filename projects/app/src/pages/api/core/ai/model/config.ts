import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import {
  GetModelConfigQuerySchema,
  GetModelConfigResponseSchema,
  type GetModelConfigQuery,
  type GetModelConfigResponse
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  getSystemModelConfigService,
  getTeamModelListService
} from '@fastgpt/service/core/ai/model/config';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/** 按显式作用域返回模型管理配置，避免公开目录接口承担多种响应形态。 */
async function handler(
  req: ApiRequestProps<Record<string, never>, GetModelConfigQuery>
): Promise<GetModelConfigResponse> {
  const { channelType } = parseApiInput({ req, querySchema: GetModelConfigQuerySchema }).query;
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

  return GetModelConfigResponseSchema.parse(
    channelType === 'system'
      ? await getSystemModelConfigService()
      : await getTeamModelListService({ tmbId, teamId })
  );
}

export default NextAPI(handler);
