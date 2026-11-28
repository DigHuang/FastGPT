import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestSandboxPvcResizeResponse } from '@fastgpt/global/openapi/admin/system/instanceConfig/testSandboxPvcResize';

const mocks = vi.hoisted(() => ({
  authSystemAdmin: vi.fn(),
  getDomainConfig: vi.fn(),
  testSandboxDynamicPvcResize: vi.fn()
}));

vi.mock('@/service/middleware/entry', () => ({ NextAPI: (handler: unknown) => handler }));

vi.mock('@fastgpt/service/support/permission/user/auth', () => ({
  authSystemAdmin: mocks.authSystemAdmin
}));

vi.mock('@fastgpt/service/common/system/systemInstanceConfig/controller', () => ({
  getDomainConfig: mocks.getDomainConfig
}));

vi.mock('@fastgpt/service/core/ai/sandbox/application/pvcResize/probe', () => ({
  testSandboxDynamicPvcResize: mocks.testSandboxDynamicPvcResize
}));

import handler from '@/pages/api/admin/system/config/testSandboxPvcResize';

const callApi = handler as unknown as (req: {
  body: Record<string, unknown>;
}) => Promise<TestSandboxPvcResizeResponse>;

const storedCredentialsBody = {
  baseUrl: 'http://dev223.local:30553',
  useStoredApiKey: true,
  image: 'registry.local/sandbox:v1',
  useServerProxy: true,
  volumeManagerUrl: 'http://dev223.local:30840',
  useStoredVolumeManagerToken: true
};

describe('POST /api/admin/system/config/testSandboxPvcResize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authSystemAdmin.mockResolvedValue({ userId: 'root' });
    mocks.getDomainConfig.mockResolvedValue({
      effectiveConfig: {
        agentSandbox: {
          opensandbox: {
            baseUrl: 'http://opensandbox.local:8080',
            apiKey: 'stored-osb-key',
            volumeManagerUrl: 'http://vm.local:3005',
            volumeManagerToken: 'stored-vm-token',
            volumeNamePrefix: 'fastgpt-session'
          }
        }
      }
    });
    mocks.testSandboxDynamicPvcResize.mockResolvedValue({
      supported: true,
      responseTimeMs: 4200,
      initialBytes: 511_705_088,
      resizedBytes: 1_038_090_240
    });
  });

  it('requires system administrator authorization before reading stored credentials', async () => {
    mocks.authSystemAdmin.mockRejectedValueOnce(new Error('denied'));
    await expect(callApi({ body: storedCredentialsBody })).rejects.toThrow('denied');
    expect(mocks.getDomainConfig).not.toHaveBeenCalled();
    expect(mocks.testSandboxDynamicPvcResize).not.toHaveBeenCalled();
  });

  it('reuses stored credentials (including on changed draft URLs) and uses draft credentials without reading stored config', async () => {
    const storedRes = await callApi({ body: storedCredentialsBody });
    expect(storedRes).toMatchObject({ supported: true, responseTimeMs: 4200 });
    expect(mocks.testSandboxDynamicPvcResize).toHaveBeenCalledWith({
      baseUrl: 'http://dev223.local:30553',
      apiKey: 'stored-osb-key',
      image: 'registry.local/sandbox:v1',
      useServerProxy: true,
      volumeManagerUrl: 'http://dev223.local:30840',
      volumeManagerToken: 'stored-vm-token',
      volumeNamePrefix: 'fastgpt-session'
    });

    vi.clearAllMocks();
    await callApi({
      body: {
        baseUrl: 'http://draft-osb.local:8080',
        apiKey: 'draft-osb-key',
        image: 'registry.local/sandbox:v2',
        useServerProxy: false,
        volumeManagerUrl: 'http://draft-vm.local:3005',
        volumeManagerToken: 'draft-vm-token',
        volumeNamePrefix: 'custom-prefix'
      }
    });
    expect(mocks.getDomainConfig).not.toHaveBeenCalled();
    expect(mocks.testSandboxDynamicPvcResize).toHaveBeenCalledWith({
      baseUrl: 'http://draft-osb.local:8080',
      apiKey: 'draft-osb-key',
      image: 'registry.local/sandbox:v2',
      useServerProxy: false,
      volumeManagerUrl: 'http://draft-vm.local:3005',
      volumeManagerToken: 'draft-vm-token',
      volumeNamePrefix: 'custom-prefix'
    });
  });

  it('rejects missing, empty, or corrupted stored credentials with 400', async () => {
    await expect(
      callApi({
        body: {
          baseUrl: 'http://opensandbox.local:8080',
          image: 'registry.local/sandbox:v1',
          useServerProxy: true,
          volumeManagerUrl: 'http://vm.local:3005',
          volumeManagerToken: 'draft-vm-token'
        }
      })
    ).rejects.toThrow();

    mocks.getDomainConfig.mockResolvedValueOnce({
      effectiveConfig: {
        agentSandbox: {
          opensandbox: { apiKey: '', volumeManagerToken: 'stored-vm-token' }
        }
      }
    });
    await expect(callApi({ body: storedCredentialsBody })).rejects.toMatchObject({
      statusCode: 400,
      message: 'OpenSandbox API Key is required'
    });

    mocks.getDomainConfig.mockResolvedValueOnce({
      effectiveConfig: {
        agentSandbox: {
          opensandbox: { apiKey: { cipher: 'corrupted' }, volumeManagerToken: 'stored-vm-token' }
        }
      }
    });
    await expect(callApi({ body: storedCredentialsBody })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Invalid stored OpenSandbox API Key'
    });
    expect(mocks.testSandboxDynamicPvcResize).not.toHaveBeenCalled();
  });
});
