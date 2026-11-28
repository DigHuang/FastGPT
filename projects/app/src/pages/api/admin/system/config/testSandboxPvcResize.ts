import type { ApiRequestProps } from '@fastgpt/next/type';
import { NextAPI } from '@/service/middleware/entry';
import { authSystemAdmin } from '@fastgpt/service/support/permission/user/auth';
import { parseApiInput } from '@fastgpt/service/common/zod/requestParseError';
import {
  TestSandboxPvcResizeBodySchema,
  TestSandboxPvcResizeResponseSchema,
  type TestSandboxPvcResizeBody,
  type TestSandboxPvcResizeResponse
} from '@fastgpt/global/openapi/admin/system/instanceConfig/testSandboxPvcResize';
import { getDomainConfig } from '@fastgpt/service/common/system/systemInstanceConfig/controller';
import { testSandboxDynamicPvcResize } from '@fastgpt/service/core/ai/sandbox/application/pvcResize/probe';
import { ApiHttpError } from '@fastgpt/service/common/http/apiError';

/**
 * Admin API - 端到端实测当前 Kubernetes 集群是否支持沙盒动态 PVC 在线扩容
 * 仅超级管理员 root 可调用；与 `/api/admin/system/config/probe` 保持一致，允许草稿直接复用已保存凭据。
 */
async function handler(
  req: ApiRequestProps<TestSandboxPvcResizeBody>
): Promise<TestSandboxPvcResizeResponse> {
  await authSystemAdmin({ req });

  const { body } = parseApiInput({
    req,
    bodySchema: TestSandboxPvcResizeBodySchema
  });

  const needsStoredConfig =
    Boolean(body.useStoredApiKey) ||
    Boolean(body.useStoredVolumeManagerToken) ||
    body.volumeNamePrefix === undefined;
  const storedOpensandbox = needsStoredConfig
    ? (await getDomainConfig('subservice')).effectiveConfig.agentSandbox.opensandbox
    : undefined;

  const resolveCredential = ({
    draft,
    stored,
    label
  }: {
    draft: string | undefined;
    stored: unknown;
    label: string;
  }): string => {
    // TestSandboxPvcResizeBodySchema 已在入参边界确保 draft 与 useStored 互斥且二选一非空。
    if (draft !== undefined) {
      return draft;
    }
    if (typeof stored !== 'string') {
      throw new ApiHttpError(400, `Invalid stored ${label}`);
    }
    if (!stored.trim()) {
      throw new ApiHttpError(400, `${label} is required`);
    }
    return stored;
  };

  const apiKey = resolveCredential({
    draft: body.apiKey,
    stored: storedOpensandbox?.apiKey,
    label: 'OpenSandbox API Key'
  });

  const volumeManagerToken = resolveCredential({
    draft: body.volumeManagerToken,
    stored: storedOpensandbox?.volumeManagerToken,
    label: 'Volume Manager Token'
  });

  const result = await testSandboxDynamicPvcResize({
    baseUrl: body.baseUrl,
    apiKey,
    image: body.image,
    useServerProxy: body.useServerProxy,
    volumeManagerUrl: body.volumeManagerUrl,
    volumeManagerToken,
    volumeNamePrefix:
      body.volumeNamePrefix ??
      (typeof storedOpensandbox?.volumeNamePrefix === 'string'
        ? storedOpensandbox.volumeNamePrefix
        : undefined)
  });

  return TestSandboxPvcResizeResponseSchema.parse(result);
}

export default NextAPI(handler);
