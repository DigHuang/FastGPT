import { authModelConfig } from '@/service/core/ai/model/auth';
import { NextAPI } from '@/service/middleware/entry';
import { channelTypeToScope } from '@fastgpt/global/core/ai/model/utils';
import {
  UpdateModelStatusBodySchema,
  type UpdateModelStatusBody
} from '@fastgpt/global/openapi/core/ai/model/api';
import type { ApiRequestProps } from '@fastgpt/next/type';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import { updateModelStatus } from '@fastgpt/service/core/ai/model/service';

async function handler(req: ApiRequestProps<UpdateModelStatusBody>): Promise<void> {
  const { modelIds, isActive, channelType } = parseApiInput({
    req,
    bodySchema: UpdateModelStatusBodySchema
  }).body;

  const {
    actor: { tmbId, teamId }
  } = await authModelConfig({ req, modelIds, channelType });

  await updateModelStatus({
    modelIds,
    isActive,
    scope: channelTypeToScope(channelType),
    teamId,
    tmbId: channelType === 'team' ? tmbId : undefined
  });
}

export default NextAPI(handler);
