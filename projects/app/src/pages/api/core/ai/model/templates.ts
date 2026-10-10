import { TeamModelCreatePermissionVal } from '@fastgpt/global/support/permission/user/constant';
import { NextAPI } from '@/service/middleware/entry';
import { ModelErrEnum } from '@fastgpt/global/common/error/code/model';
import { sortModelsByProvider } from '@fastgpt/global/core/ai/model/provider';
import {
  GetModelTemplatesQuerySchema,
  GetModelTemplatesResponseSchema,
  type GetModelTemplatesQuery,
  type GetModelTemplatesResponse
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  getModelProviderMetadata,
  preloadModelProviders
} from '@fastgpt/service/core/ai/model/provider/controller';
import { refreshModelTemplates } from '@fastgpt/service/core/ai/model/template';
import { assertTeamModelEnabled } from '@fastgpt/service/core/ai/model/utils';
import { authUserPer } from '@fastgpt/service/support/permission/user/auth';

/**
 * 实时返回 Plugin 模型模板；响应不会写入任何运行时或持久化模型缓存。
 * system 仅 root；team 需要“安装模型”权限，成员创建团队模型时也要从模板入口选择。
 */
async function handler(
  req: ApiRequestProps<Record<string, never>, GetModelTemplatesQuery>
): Promise<GetModelTemplatesResponse> {
  const { channelType } = parseApiInput({
    req,
    querySchema: GetModelTemplatesQuerySchema
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

  await preloadModelProviders();
  const models = await refreshModelTemplates();
  const providers = getModelProviderMetadata().providers;

  return GetModelTemplatesResponseSchema.parse({
    models: sortModelsByProvider(models, providers),
    providers
  });
}

export default NextAPI(handler);
