import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultInstanceConfig,
  getTestInstanceConfig
} from '@test/utils/instanceConfigSnapshot';
import { SandboxNotFoundError } from '@fastgpt/service/core/ai/sandbox/infrastructure/opensandbox/errors';

const mocks = vi.hoisted(() => ({
  getSandboxDiskUsage: vi.fn(),
  inspectSessionVolume: vi.fn(),
  resizeSessionVolume: vi.fn()
}));

vi.mock('@fastgpt/service/core/ai/sandbox/application/ideAgent', () => ({
  getSandboxDiskUsage: mocks.getSandboxDiskUsage
}));

vi.mock('@fastgpt/service/core/ai/sandbox/infrastructure/volume/service', () => ({
  inspectSessionVolume: mocks.inspectSessionVolume,
  resizeSessionVolume: mocks.resizeSessionVolume
}));

import type { SandboxDiskProbeClient } from '@fastgpt/service/core/ai/sandbox/application/ideAgent';
import {
  computeArchiveRestoreStorageSize,
  computeTargetPvcResizePlan
} from '@fastgpt/service/core/ai/sandbox/application/pvcResize/plan';
import {
  ensureSandboxPvcCapacity,
  expandSandboxPvcToMaxCapacity,
  resetSandboxPvcResizeStateForTest
} from '@fastgpt/service/core/ai/sandbox/application/pvcResize/service';

const MIB = 1024 * 1024;
const fsUsage = (totalMiB: number, usedMiB: number, availableMiB: number) => ({
  totalBytes: totalMiB * MIB,
  usedBytes: usedMiB * MIB,
  availableBytes: availableMiB * MIB
});

describe('sandbox dynamic PVC resize planning', () => {
  it('computes target PVC resize plan from usage threshold, incomingBytes, ext4 overhead, and max clamp', () => {
    // 1. 仅同时满足使用率 >= 80% 且 剩余 < 200MiB 才触发
    expect(
      computeTargetPvcResizePlan({ filesystem: fsUsage(488, 300, 150), maxStorageSizeGi: 5 })
    ).toEqual({ shouldResize: false, currentAllocatedMiB: 512, maxMiB: 5120 });
    expect(
      computeTargetPvcResizePlan({ filesystem: fsUsage(1980, 1650, 300), maxStorageSizeGi: 5 })
    ).toEqual({ shouldResize: false, currentAllocatedMiB: 2048, maxMiB: 5120 });
    expect(
      computeTargetPvcResizePlan({ filesystem: fsUsage(488, 370, 80), maxStorageSizeGi: 5 })
    ).toEqual({
      shouldResize: true,
      currentAllocatedMiB: 512,
      targetMiB: 1024,
      maxMiB: 5120,
      targetStorageSize: '1024Mi'
    });

    // 2. 大写入按 0.5Gi 步长多步扩容并计入 ext4 ~8% 开销（10GiB 上传 -> 11776Mi）
    expect(
      computeTargetPvcResizePlan({
        filesystem: fsUsage(488, 10, 462),
        maxStorageSizeGi: 20,
        incomingBytes: 10 * 1024 * MIB
      })
    ).toMatchObject({ shouldResize: true, targetMiB: 11_776, targetStorageSize: '11776Mi' });

    // 3. 封顶 storageSizeGi，已达上限时不触发
    expect(
      computeTargetPvcResizePlan({
        filesystem: fsUsage(488, 150, 300),
        maxStorageSizeGi: 1,
        incomingBytes: 900 * MIB
      })
    ).toMatchObject({ shouldResize: true, targetMiB: 1024, targetStorageSize: '1024Mi' });
    expect(
      computeTargetPvcResizePlan({ filesystem: fsUsage(990, 850, 80), maxStorageSizeGi: 1 })
    ).toEqual({ shouldResize: false, currentAllocatedMiB: 1024, maxMiB: 1024 });
  });

  it('computes archive restore storage size from uncompressedBytes or 4x legacy fallback', () => {
    expect(
      computeArchiveRestoreStorageSize({
        maxStorageSizeGi: 5,
        uncompressedBytes: 0,
        archiveSizeBytes: 0
      })
    ).toBe('512Mi');
    expect(
      computeArchiveRestoreStorageSize({
        maxStorageSizeGi: 20,
        uncompressedBytes: 10 * 1024 * MIB,
        archiveSizeBytes: 3 * 1024 * MIB
      })
    ).toBe('11776Mi');
    // 历史归档无 uncompressedBytes 时按 4 倍估算，小归档仍保持 512Mi
    expect(
      computeArchiveRestoreStorageSize({ maxStorageSizeGi: 5, archiveSizeBytes: 300 * MIB })
    ).toBe('1536Mi');
    expect(
      computeArchiveRestoreStorageSize({ maxStorageSizeGi: 5, archiveSizeBytes: 10 * MIB })
    ).toBe('512Mi');
    expect(
      computeArchiveRestoreStorageSize({
        maxStorageSizeGi: 2,
        uncompressedBytes: 3 * 1024 * MIB,
        archiveSizeBytes: 1024 * MIB
      })
    ).toBe('2048Mi');
  });
});

describe('ensureSandboxPvcCapacity', () => {
  const createSandbox = (claimName = 'fastgpt-session-app-1-0'): SandboxDiskProbeClient => ({
    id: 'sbx-k8s-1',
    workspaceClaimName: claimName,
    getEndpoint: vi.fn(),
    readFiles: vi.fn()
  });

  const snapshot = (totalMiB = 488, usedMiB = 380, availableMiB = 70) => ({
    usedBytes: usedMiB * MIB,
    limitBytes: null,
    filesystem: fsUsage(totalMiB, usedMiB, availableMiB)
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetSandboxPvcResizeStateForTest();
    global.systemInstanceConfig = createDefaultInstanceConfig();
    getTestInstanceConfig().subservice.agentSandbox.opensandbox.runtime = 'kubernetes';
    getTestInstanceConfig().subservice.agentSandbox.opensandbox.enableDynamicPvcResize = true;
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 5;
  });

  afterEach(() => {
    resetSandboxPvcResizeStateForTest();
    global.systemInstanceConfig = createDefaultInstanceConfig();
  });

  it('skips when disabled or docker, and expands PVC online until statvfs reflects growth', async () => {
    getTestInstanceConfig().subservice.agentSandbox.opensandbox.enableDynamicPvcResize = false;
    await ensureSandboxPvcCapacity({ sandbox: createSandbox() });
    getTestInstanceConfig().subservice.agentSandbox.opensandbox.runtime = 'docker';
    getTestInstanceConfig().subservice.agentSandbox.opensandbox.enableDynamicPvcResize = true;
    await ensureSandboxPvcCapacity({ sandbox: createSandbox() });
    expect(mocks.getSandboxDiskUsage).not.toHaveBeenCalled();

    getTestInstanceConfig().subservice.agentSandbox.opensandbox.runtime = 'kubernetes';
    const sandbox = createSandbox('fastgpt-session-grow-0');
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockResolvedValueOnce(snapshot(990, 380, 570));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-grow-0',
      resized: true,
      requestedBytes: 1024 * MIB
    });

    await ensureSandboxPvcCapacity({ sandbox, waitTimeoutMs: 500, pollIntervalMs: 1 });

    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(3);
    expect(mocks.resizeSessionVolume).toHaveBeenCalledWith('fastgpt-session-grow-0', {
      storageSize: '1024Mi',
      signal: undefined
    });
  });

  it('fails open with cooldown on resize error and rethrows recoverable errors on initial probe', async () => {
    const sandbox = createSandbox('fastgpt-session-fail-0');
    mocks.getSandboxDiskUsage.mockRejectedValueOnce(new SandboxNotFoundError('gone'));
    await expect(
      ensureSandboxPvcCapacity({ sandbox, rethrowRecoverable: true })
    ).rejects.toBeInstanceOf(SandboxNotFoundError);

    mocks.getSandboxDiskUsage.mockResolvedValueOnce(snapshot(488, 390, 60));
    mocks.resizeSessionVolume.mockRejectedValueOnce(new Error('422 expansion forbidden'));

    await ensureSandboxPvcCapacity({ sandbox, waitTimeoutMs: 50, pollIntervalMs: 1 });
    // 冷却期内直接跳过
    await ensureSandboxPvcCapacity({ sandbox });
    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(2);
    expect(mocks.resizeSessionVolume).toHaveBeenCalledTimes(1);
  });

  it('handles resized=false across maxed PVC, >=26GiB ext4 underestimate, concurrent completion, and in-progress growth', async () => {
    // 1. 已达上限（缺少 capacityBytes 时回退一次 inspectSessionVolume），零轮询直接返回
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 30;
    const maxedSandbox = createSandbox('fastgpt-session-maxed-0');
    mocks.getSandboxDiskUsage.mockResolvedValueOnce(snapshot(30_100, 29_950, 50));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-maxed-0',
      resized: false,
      requestedBytes: 30_720 * MIB
    });
    mocks.inspectSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-maxed-0',
      requestedBytes: 30_720 * MIB,
      capacityBytes: 30_720 * MIB
    });
    await ensureSandboxPvcCapacity({
      sandbox: maxedSandbox,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 50
    });
    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(1);
    expect(mocks.inspectSessionVolume).toHaveBeenCalledTimes(1);

    // 2. 未达上限但 >=26GiB ext4 元数据导致 statvfs 低估 -> 基于权威容量追发下一步 PATCH
    vi.clearAllMocks();
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 50;
    const largeSandbox = createSandbox('fastgpt-session-large-grow-0');
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(30_100, 29_950, 50))
      .mockResolvedValueOnce(snapshot(30_100, 29_950, 50))
      .mockResolvedValueOnce(snapshot(30_600, 29_950, 550));
    mocks.resizeSessionVolume
      .mockResolvedValueOnce({
        claimName: 'fastgpt-session-large-grow-0',
        resized: false,
        requestedBytes: 30_720 * MIB,
        capacityBytes: 30_720 * MIB
      })
      .mockResolvedValueOnce({
        claimName: 'fastgpt-session-large-grow-0',
        resized: true,
        requestedBytes: 31_232 * MIB,
        capacityBytes: 30_720 * MIB
      });
    await ensureSandboxPvcCapacity({
      sandbox: largeSandbox,
      waitTimeoutMs: 500,
      pollIntervalMs: 1
    });
    expect(mocks.resizeSessionVolume).toHaveBeenNthCalledWith(2, 'fastgpt-session-large-grow-0', {
      storageSize: '31232Mi',
      signal: undefined
    });

    // 3. 并发扩容刚落地（重探 statvfs 已见增长）-> 绝不二次扩容
    vi.clearAllMocks();
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 5;
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockResolvedValueOnce(snapshot(990, 380, 570));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-concurrent-done-0',
      resized: false,
      requestedBytes: 1024 * MIB,
      capacityBytes: 1024 * MIB
    });
    await ensureSandboxPvcCapacity({
      sandbox: createSandbox('fastgpt-session-concurrent-done-0'),
      waitTimeoutMs: 500,
      pollIntervalMs: 1
    });
    expect(mocks.resizeSessionVolume).toHaveBeenCalledTimes(1);

    // 4. capacityBytes 尚未追上 requestedBytes -> 继续等待 statvfs 生效
    vi.clearAllMocks();
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockResolvedValueOnce(snapshot(990, 380, 570));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-inprogress-0',
      resized: false,
      requestedBytes: 1024 * MIB,
      capacityBytes: 512 * MIB
    });
    await ensureSandboxPvcCapacity({
      sandbox: createSandbox('fastgpt-session-inprogress-0'),
      waitTimeoutMs: 500,
      pollIntervalMs: 1
    });
    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(2);
    expect(mocks.inspectSessionVolume).not.toHaveBeenCalled();
  });

  it('waits past intermediate steps on multi-step resize and accepts fractional storageSizeGi tail steps', async () => {
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 150, 300))
      .mockResolvedValueOnce(snapshot(990, 150, 780))
      .mockResolvedValueOnce(snapshot(1490, 150, 1260));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-multi-0',
      resized: true,
      requestedBytes: 1536 * MIB
    });
    await ensureSandboxPvcCapacity({
      sandbox: createSandbox('fastgpt-session-multi-0'),
      incomingBytes: 900 * MIB,
      waitTimeoutMs: 500,
      pollIntervalMs: 1
    });
    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(3);

    // 小数 storageSizeGi = 1.02（末步增量 20Mi < 32Mi）按一半门槛放行
    vi.clearAllMocks();
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 1.02;
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(990, 880, 60))
      .mockResolvedValueOnce(snapshot(1008, 880, 78));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-frac-0',
      resized: true,
      requestedBytes: 1044 * MIB
    });
    await ensureSandboxPvcCapacity({
      sandbox: createSandbox('fastgpt-session-frac-0'),
      waitTimeoutMs: 500,
      pollIntervalMs: 1
    });
    expect(mocks.resizeSessionVolume).toHaveBeenCalledWith('fastgpt-session-frac-0', {
      storageSize: '1044Mi',
      signal: undefined
    });
    expect(mocks.getSandboxDiskUsage).toHaveBeenCalledTimes(2);
  });

  it('propagates caller abort during wait polling without polluting failure cooldown', async () => {
    const sandbox = createSandbox('fastgpt-session-abort-0');
    const controller = new AbortController();

    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockImplementationOnce(async () => {
        controller.abort(new Error('request cancelled'));
        throw new Error('aborted during poll');
      });
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-abort-0',
      resized: true,
      requestedBytes: 1024 * MIB
    });

    await expect(
      ensureSandboxPvcCapacity({
        sandbox,
        signal: controller.signal,
        waitTimeoutMs: 500,
        pollIntervalMs: 1
      })
    ).rejects.toThrow('aborted during poll');

    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 380, 70))
      .mockResolvedValueOnce(snapshot(990, 380, 570));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-abort-0',
      resized: true,
      requestedBytes: 1024 * MIB
    });
    await ensureSandboxPvcCapacity({ sandbox, waitTimeoutMs: 500, pollIntervalMs: 1 });
    expect(mocks.resizeSessionVolume).toHaveBeenCalledTimes(2);
  });

  it('expands PVC directly to max capacity for archive restore retry and returns false when maxed or unprobeable', async () => {
    const sandbox = createSandbox('fastgpt-session-restore-0');
    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 2;
    mocks.getSandboxDiskUsage
      .mockResolvedValueOnce(snapshot(488, 480, 0))
      .mockResolvedValueOnce(snapshot(1980, 480, 1450));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-restore-0',
      resized: true,
      requestedBytes: 2048 * MIB
    });

    await expect(
      expandSandboxPvcToMaxCapacity({
        sandbox,
        claimName: 'fastgpt-session-restore-0',
        waitTimeoutMs: 500,
        pollIntervalMs: 1
      })
    ).resolves.toBe(true);
    expect(mocks.resizeSessionVolume).toHaveBeenCalledWith('fastgpt-session-restore-0', {
      storageSize: '2048Mi',
      signal: undefined
    });

    // 无基线 statvfs 或已达上限均直接返回 false
    mocks.getSandboxDiskUsage.mockRejectedValueOnce(new Error('ide-agent unreachable'));
    await expect(
      expandSandboxPvcToMaxCapacity({
        sandbox,
        claimName: 'fastgpt-session-restore-0',
        waitTimeoutMs: 500,
        pollIntervalMs: 1
      })
    ).resolves.toBe(false);

    getTestInstanceConfig().subservice.agentSandbox.common.storageSizeGi = 30;
    mocks.getSandboxDiskUsage.mockResolvedValueOnce(snapshot(30_100, 30_050, 0));
    mocks.resizeSessionVolume.mockResolvedValueOnce({
      claimName: 'fastgpt-session-restore-0',
      resized: false,
      requestedBytes: 30_720 * MIB,
      capacityBytes: 30_720 * MIB
    });
    await expect(
      expandSandboxPvcToMaxCapacity({
        sandbox,
        claimName: 'fastgpt-session-restore-0',
        waitTimeoutMs: 5_000,
        pollIntervalMs: 50
      })
    ).resolves.toBe(false);
    expect(mocks.resizeSessionVolume).toHaveBeenCalledTimes(2);
  });
});
