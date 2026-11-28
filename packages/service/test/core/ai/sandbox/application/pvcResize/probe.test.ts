import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultInstanceConfig } from '@test/utils/instanceConfigSnapshot';
import { RedisLeaseUnavailableError } from '@fastgpt/dal/redis/caches';

type LeaseCallback = (lease: { signal: AbortSignal; assertValid: () => void }) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  withLease: vi.fn(),
  ensureSessionVolume: vi.fn(),
  resizeSessionVolume: vi.fn(),
  inspectSessionVolume: vi.fn(),
  deleteSessionVolume: vi.fn(),
  createRuntimeOpenSandboxClient: vi.fn(),
  disconnectSandbox: vi.fn(),
  getSandboxDiskUsage: vi.fn()
}));

vi.mock('@fastgpt/dal/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fastgpt/dal/redis/caches')>();
  class MockLeaseCache {
    withLease = mocks.withLease;
  }
  return { ...actual, LeaseCache: MockLeaseCache };
});

vi.mock(
  '@fastgpt/service/core/ai/sandbox/infrastructure/volume/service',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@fastgpt/service/core/ai/sandbox/infrastructure/volume/service')
      >();
    return {
      ...actual,
      ensureSessionVolume: mocks.ensureSessionVolume,
      resizeSessionVolume: mocks.resizeSessionVolume,
      inspectSessionVolume: mocks.inspectSessionVolume,
      deleteSessionVolume: mocks.deleteSessionVolume
    };
  }
);

vi.mock(
  '@fastgpt/service/core/ai/sandbox/infrastructure/opensandbox/opensandbox',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@fastgpt/service/core/ai/sandbox/infrastructure/opensandbox/opensandbox')
      >();
    return {
      ...actual,
      createRuntimeOpenSandboxClient: mocks.createRuntimeOpenSandboxClient,
      disconnectSandbox: mocks.disconnectSandbox
    };
  }
);

vi.mock('@fastgpt/service/core/ai/sandbox/application/ideAgent', () => ({
  getSandboxDiskUsage: mocks.getSandboxDiskUsage
}));

import { VolumeManagerHttpError } from '@fastgpt/service/core/ai/sandbox/infrastructure/volume/service';
import { testSandboxDynamicPvcResize } from '@fastgpt/service/core/ai/sandbox/application/pvcResize/probe';

const MIB = 1024 * 1024;
const fsSnapshot = (totalMiB: number) => ({
  usedBytes: 10 * MIB,
  filesystem: {
    totalBytes: totalMiB * MIB,
    availableBytes: Math.max(0, (totalMiB - 38) * MIB),
    usedBytes: 10 * MIB
  }
});

describe('testSandboxDynamicPvcResize', () => {
  const baseInput = {
    baseUrl: 'http://opensandbox.local:8080',
    apiKey: 'osb-secret-key-9999',
    image: 'registry.local/fastgpt-agent-sandbox:v0.5.0',
    useServerProxy: true,
    volumeManagerUrl: 'http://volume-manager.local:3005',
    volumeManagerToken: 'vm-secret-token-8888',
    volumeNamePrefix: 'fastgpt-session'
  };

  let mockSandbox: {
    ensureRunning: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    global.systemInstanceConfig = createDefaultInstanceConfig();
    mockSandbox = {
      ensureRunning: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined)
    };
    mocks.withLease.mockImplementation(async ({ fn }: { fn: LeaseCallback }) => {
      const controller = new AbortController();
      return fn({ signal: controller.signal, assertValid: () => undefined });
    });
    mocks.ensureSessionVolume.mockImplementation(async (claimName: string) => claimName);
    mocks.deleteSessionVolume.mockResolvedValue(undefined);
    mocks.disconnectSandbox.mockResolvedValue(undefined);
    mocks.createRuntimeOpenSandboxClient.mockReturnValue(mockSandbox);
    mocks.inspectSessionVolume.mockResolvedValue({ claimName: 'probe', conditions: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    global.systemInstanceConfig = createDefaultInstanceConfig();
  });

  it('verifies 512Mi -> 1024Mi online resize with isolated connection, K8s env, lightweight limits, and Pod-then-PVC cleanup', async () => {
    // 即使实例当前仍保存为 docker 与大规格，草稿探测也必须使用 kubernetes env 与轻量资源规格。
    global.systemInstanceConfig.subservice.agentSandbox.opensandbox.runtime = 'docker';
    global.systemInstanceConfig.subservice.agentSandbox.common.cpuCount = 8;
    global.systemInstanceConfig.subservice.agentSandbox.common.memoryMiB = 16384;

    const cleanupOrder: string[] = [];
    mockSandbox.delete.mockImplementation(async () => {
      cleanupOrder.push('pod');
    });
    mocks.deleteSessionVolume.mockImplementation(async () => {
      cleanupOrder.push('pvc');
    });
    mocks.resizeSessionVolume.mockResolvedValue({ claimName: 'probe', resized: true });
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(fsSnapshot(488))
      .mockResolvedValueOnce(fsSnapshot(990));

    const promise = testSandboxDynamicPvcResize(baseInput);
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({
      supported: true,
      responseTimeMs: expect.any(Number),
      initialBytes: 488 * MIB,
      resizedBytes: 990 * MIB
    });
    expect(mocks.ensureSessionVolume).toHaveBeenCalledWith(
      expect.stringMatching(/^fastgpt-session-probe-pvc-[a-f0-9]{12}-0$/),
      expect.objectContaining({ storageSize: '512Mi' })
    );
    expect(mocks.resizeSessionVolume).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ storageSize: '1024Mi' })
    );
    expect(mocks.createRuntimeOpenSandboxClient).toHaveBeenCalledWith(
      expect.objectContaining({
        isolatedConnection: true,
        runtimeConfig: expect.objectContaining({
          createConfig: expect.objectContaining({
            resourceLimits: { cpuCount: 0.5, memoryMiB: 512 },
            timeoutSeconds: 300
          })
        })
      })
    );
    const createdEnv =
      mocks.createRuntimeOpenSandboxClient.mock.calls[0]?.[0]?.runtimeConfig?.createConfig?.env;
    expect(createdEnv).not.toHaveProperty('FASTGPT_DISK_SOFT_LIMIT_BYTES');
    expect(cleanupOrder).toEqual(['pod', 'pvc']);
  });

  it('classifies min_size_too_large, concurrent_test, rbac_denied, expansion_not_allowed, and unbound 422 failed', async () => {
    mocks.withLease.mockRejectedValueOnce(
      new RedisLeaseUnavailableError('agent-sandbox:pvc-resize-probe')
    );
    expect(await testSandboxDynamicPvcResize(baseInput)).toMatchObject({
      supported: false,
      errorCode: 'concurrent_test'
    });

    mocks.getSandboxDiskUsage.mockResolvedValueOnce(fsSnapshot(20 * 1024));
    expect(await testSandboxDynamicPvcResize(baseInput)).toMatchObject({
      supported: false,
      errorCode: 'min_size_too_large',
      initialBytes: 20 * 1024 * MIB
    });
    expect(mocks.resizeSessionVolume).not.toHaveBeenCalled();

    const patchErrors: Array<[number, string, string]> = [
      [
        403,
        'User "system:serviceaccount:opensandbox:volume-manager" cannot patch resource "persistentvolumeclaims"',
        'rbac_denied'
      ],
      [
        403,
        'K8s PVC resize failed (403): {"kind":"Status","message":"only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize","code":403}',
        'expansion_not_allowed'
      ],
      [
        422,
        'spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims',
        'failed'
      ]
    ];
    for (const [status, body, expectedCode] of patchErrors) {
      mocks.getSandboxDiskUsage.mockResolvedValueOnce(fsSnapshot(488));
      mocks.resizeSessionVolume.mockRejectedValueOnce(new VolumeManagerHttpError({ status, body }));
      expect(await testSandboxDynamicPvcResize(baseInput)).toMatchObject({
        supported: false,
        errorCode: expectedCode
      });
    }
  });

  it('tolerates slow online CSI expansion and distinguishes offline_resize_only vs resize_timeout at deadline', async () => {
    // 1. 慢在线 CSI：轮询多次后生效 -> supported: true，不提前 inspect
    let pollCalls = 0;
    mocks.getSandboxDiskUsage.mockImplementation(async () => {
      pollCalls += 1;
      return fsSnapshot(pollCalls >= 10 ? 990 : 488);
    });
    mocks.resizeSessionVolume.mockResolvedValueOnce({ claimName: 'probe', resized: true });

    const onlinePromise = testSandboxDynamicPvcResize(baseInput);
    await vi.runAllTimersAsync();
    expect(await onlinePromise).toMatchObject({
      supported: true,
      initialBytes: 488 * MIB,
      resizedBytes: 990 * MIB
    });
    expect(mocks.inspectSessionVolume).not.toHaveBeenCalled();

    // 2. 到期仍处于 FileSystemResizePending -> offline_resize_only
    mocks.getSandboxDiskUsage.mockResolvedValue(fsSnapshot(488));
    mocks.resizeSessionVolume.mockResolvedValueOnce({ claimName: 'probe', resized: true });
    mocks.inspectSessionVolume.mockResolvedValueOnce({
      claimName: 'probe',
      conditions: [{ type: 'FileSystemResizePending', status: 'True' }]
    });
    const offlinePromise = testSandboxDynamicPvcResize(baseInput);
    await vi.runAllTimersAsync();
    expect(await offlinePromise).toMatchObject({
      supported: false,
      errorCode: 'offline_resize_only'
    });

    // 3. 到期无 FileSystemResizePending -> resize_timeout
    mocks.resizeSessionVolume.mockResolvedValueOnce({ claimName: 'probe', resized: true });
    mocks.inspectSessionVolume.mockResolvedValueOnce({
      claimName: 'probe',
      conditions: [{ type: 'Resizing', status: 'True', message: 'transient CSI error' }]
    });
    const timeoutPromise = testSandboxDynamicPvcResize(baseInput);
    await vi.runAllTimersAsync();
    expect(await timeoutPromise).toMatchObject({
      supported: false,
      errorCode: 'resize_timeout'
    });
  });

  it('sanitizes credentials and raw K8s JSON on failed errors and cleans up ambiguous 5xx but skips 4xx', async () => {
    mocks.ensureSessionVolume.mockRejectedValueOnce(
      new VolumeManagerHttpError({
        status: 500,
        body: `K8s PVC create failed (500): {"kind":"Status","message":"upstream rejected Bearer secret-hdr with ${baseInput.volumeManagerToken} and ${baseInput.apiKey} at https://internal.ns-prod.svc:6443"}`
      })
    );
    const result = await testSandboxDynamicPvcResize(baseInput);
    expect(result).toMatchObject({ supported: false, errorCode: 'failed' });
    expect(result.error).not.toContain(baseInput.apiKey);
    expect(result.error).not.toContain(baseInput.volumeManagerToken);
    expect(result.error).not.toContain('secret-hdr');
    expect(result.error).not.toContain('"kind":"Status"');
    expect(mocks.deleteSessionVolume).toHaveBeenCalledTimes(1);

    mocks.deleteSessionVolume.mockClear();
    mocks.ensureSessionVolume.mockRejectedValueOnce(
      new VolumeManagerHttpError({ status: 401, body: 'Unauthorized' })
    );
    expect(await testSandboxDynamicPvcResize(baseInput)).toMatchObject({
      supported: false,
      errorCode: 'failed'
    });
    expect(mocks.deleteSessionVolume).not.toHaveBeenCalled();
  });
});
