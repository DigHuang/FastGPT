/**
 * Kubernetes Agent Sandbox 动态 PVC 在线扩容运行期编排。
 *
 * 通过 `fastgpt-ide-agent` `GET /disk-usage?scope=filesystem` 执行 O(1) `statvfs` 探测，
 * 命中水位后调用幂等 `volume-manager` `PATCH /v1/volumes/:claimName/resize` 并等待文件系统生效；
 * 扩容或等待超时统一记录告警、进入有界短冷却并 fail-open 放行，不中断主流程。
 */
import { storageSizeGiToMiB } from '@fastgpt/global/core/ai/sandbox/constants';
import { delayWithSignal, throwIfAborted } from '@fastgpt/global/common/system/utils';
import { getLogger, LogCategories } from '../../../../../common/logger';
import { getAgentSandboxCommonConfig, isAgentSandboxDynamicPvcResizeEnabled } from '../../config';
import {
  SANDBOX_PVC_RESIZE_BLOCKING_POLL_INTERVAL_MS,
  SANDBOX_PVC_RESIZE_BLOCKING_WAIT_TIMEOUT_MS,
  SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES,
  SANDBOX_PVC_RESIZE_FAILURE_COOLDOWN_MS,
  SANDBOX_PVC_RESIZE_POLL_INTERVAL_MS,
  SANDBOX_PVC_RESIZE_WAIT_TIMEOUT_MS
} from '../../constants';
import { isRecoverableSandboxError } from '../../infrastructure/opensandbox/errors';
import { inspectSessionVolume, resizeSessionVolume } from '../../infrastructure/volume/service';
import {
  getSandboxDiskUsage,
  type IdeAgentEndpointClient,
  type SandboxDiskProbeClient
} from '../ideAgent';
import {
  MIB_BYTES,
  alignBytesToStepMiB,
  computeRequiredGrowthBytes,
  computeTargetPvcResizePlan,
  isPvcAtMaxCapacity
} from './plan';

const logger = getLogger(LogCategories.MODULE.AI.SANDBOX);
const FAILED_RESIZE_COOLDOWN_MAX_SIZE = 512;

/** 扩容失败或等待生效超时后的有界短冷却截止时间，防止同一故障卷在连续工具调用中反复卡满等待超时。 */
const failedResizeUntilByClaim = new Map<string, number>();

const isInResizeCooldown = (claimName: string, now = Date.now()): boolean => {
  const cooldownUntil = failedResizeUntilByClaim.get(claimName);
  if (cooldownUntil === undefined) return false;
  if (now < cooldownUntil) return true;
  failedResizeUntilByClaim.delete(claimName);
  return false;
};

const recordFailedResizeCooldown = (claimName: string, now = Date.now()): void => {
  for (const [key, until] of failedResizeUntilByClaim) {
    if (until <= now) {
      failedResizeUntilByClaim.delete(key);
    }
  }
  failedResizeUntilByClaim.delete(claimName);
  while (failedResizeUntilByClaim.size >= FAILED_RESIZE_COOLDOWN_MAX_SIZE) {
    const oldestKey = failedResizeUntilByClaim.keys().next().value;
    if (oldestKey === undefined) break;
    failedResizeUntilByClaim.delete(oldestKey);
  }
  failedResizeUntilByClaim.set(claimName, now + SANDBOX_PVC_RESIZE_FAILURE_COOLDOWN_MS);
};

/**
 * 读取 PVC 在 Kubernetes 侧的权威 `requestedBytes` 与 `capacityBytes`。
 * 优先复用 PATCH 响应字段，缺失时回退一次 `inspectSessionVolume`。
 */
async function readAuthoritativePvcBytes(params: {
  claimName: string;
  resizeResult: { requestedBytes?: number; capacityBytes?: number };
  signal?: AbortSignal;
}): Promise<{ requestedBytes?: number; capacityBytes?: number }> {
  let { requestedBytes, capacityBytes } = params.resizeResult;

  if (capacityBytes === undefined || requestedBytes === undefined) {
    const inspected = await inspectSessionVolume(params.claimName, {
      signal: params.signal
    }).catch((error) => {
      if (params.signal?.aborted) {
        throw error;
      }
      return undefined;
    });
    throwIfAborted(params.signal);
    requestedBytes ??= inspected?.requestedBytes;
    capacityBytes ??= inspected?.capacityBytes;
  }

  return { requestedBytes, capacityBytes };
}

/** 轮询容器内 `statvfs` 直到文件系统总容量增长覆盖目标增量（或满足已知大写入可用空间）。 */
async function waitForFilesystemExpansion(params: {
  sandbox: IdeAgentEndpointClient;
  beforeTotalBytes: number;
  expectedDeltaBytes: number;
  incomingBytes?: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<number | undefined> {
  const requiredGrowthBytes = computeRequiredGrowthBytes(params.expectedDeltaBytes);
  const minEffectiveGrowthBytes = Math.min(
    SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES,
    requiredGrowthBytes
  );
  const incomingBytes =
    typeof params.incomingBytes === 'number' &&
    Number.isFinite(params.incomingBytes) &&
    params.incomingBytes > 0
      ? params.incomingBytes
      : 0;
  const deadline = Date.now() + params.waitTimeoutMs;

  while (Date.now() < deadline) {
    await delayWithSignal(
      Math.min(params.pollIntervalMs, Math.max(1, deadline - Date.now())),
      params.signal
    );
    const latest = await getSandboxDiskUsage({
      sandbox: params.sandbox,
      scope: 'filesystem',
      signal: params.signal
    }).catch((error) => {
      if (params.signal?.aborted) {
        throw error;
      }
      return undefined;
    });
    throwIfAborted(params.signal);
    const fs = latest?.filesystem;
    if (!fs) continue;

    const grownBytes = fs.totalBytes - params.beforeTotalBytes;
    if (grownBytes >= requiredGrowthBytes) {
      return fs.totalBytes;
    }
    if (
      incomingBytes > 0 &&
      grownBytes >= minEffectiveGrowthBytes &&
      fs.availableBytes >= incomingBytes
    ) {
      return fs.totalBytes;
    }
  }
  return undefined;
}

/**
 * 将运行中 Kubernetes 沙盒的 PVC 一步在线扩容至全局上限 `storageSizeGi` 并等待文件系统生效。
 *
 * 用于冷归档恢复解压遭遇极端压缩比触发 `ENOSPC` 时的兜底扩容重试；若已达上限、无法读取基线或扩容失败返回 `false`。
 */
export async function expandSandboxPvcToMaxCapacity(params: {
  sandbox: IdeAgentEndpointClient;
  claimName: string;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  if (!isAgentSandboxDynamicPvcResizeEnabled()) {
    return false;
  }

  const maxMiB = storageSizeGiToMiB(getAgentSandboxCommonConfig().storageSizeGi);
  const targetStorageSize = `${maxMiB}Mi`;

  const currentUsage = await getSandboxDiskUsage({
    sandbox: params.sandbox,
    scope: 'filesystem',
    signal: params.signal
  }).catch((error) => {
    if (params.signal?.aborted) {
      throw error;
    }
    return undefined;
  });
  throwIfAborted(params.signal);

  const beforeTotalBytes = currentUsage?.filesystem?.totalBytes ?? 0;
  // 无扩容前文件系统基线时无法可靠校验增量生效，直接放弃避免误判已扩容后重复下载解压。
  if (beforeTotalBytes <= 0 || alignBytesToStepMiB(beforeTotalBytes) >= maxMiB) {
    return false;
  }

  const currentAllocatedMiB = Math.min(maxMiB, alignBytesToStepMiB(beforeTotalBytes));
  const expectedDeltaBytes = Math.max(1, (maxMiB - currentAllocatedMiB) * MIB_BYTES);

  try {
    const resizeResult = await resizeSessionVolume(params.claimName, {
      storageSize: targetStorageSize,
      signal: params.signal
    });
    if (!resizeResult.resized) {
      const { requestedBytes, capacityBytes } = await readAuthoritativePvcBytes({
        claimName: params.claimName,
        resizeResult,
        signal: params.signal
      });
      if (isPvcAtMaxCapacity({ requestedBytes, capacityBytes, maxBytes: maxMiB * MIB_BYTES })) {
        return false;
      }
    }

    const afterTotalBytes = await waitForFilesystemExpansion({
      sandbox: params.sandbox,
      beforeTotalBytes,
      expectedDeltaBytes,
      waitTimeoutMs: params.waitTimeoutMs ?? SANDBOX_PVC_RESIZE_BLOCKING_WAIT_TIMEOUT_MS,
      pollIntervalMs: params.pollIntervalMs ?? SANDBOX_PVC_RESIZE_BLOCKING_POLL_INTERVAL_MS,
      signal: params.signal
    });
    if (afterTotalBytes !== undefined) {
      logger.info('[Sandbox PvcResize] Expanded PVC to max capacity for archive restore retry', {
        sandboxId: params.sandbox.id,
        claimName: params.claimName,
        beforeTotalBytes,
        afterTotalBytes,
        targetStorageSize
      });
      return true;
    }
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    logger.warn('[Sandbox PvcResize] Failed to expand PVC to max capacity during archive restore', {
      sandboxId: params.sandbox.id,
      claimName: params.claimName,
      targetStorageSize,
      error
    });
  }

  return false;
}

/** 清理本进程动态扩容失败冷却表（仅供单测使用）。 */
export function resetSandboxPvcResizeStateForTest(): void {
  failedResizeUntilByClaim.clear();
}

/**
 * 写前检查运行中 Kubernetes 沙盒的 PVC 空间水位，命中阈值时自动触发在线扩容并短等待生效。
 *
 * - 仅在 `runtime === 'kubernetes'` 且开启 `enableDynamicPvcResize` 时生效，其余场景零开销返回；
 * - 首次探测遇到可恢复容器异常且 `rethrowRecoverable: true` 时透传给外层 `runWithRecovery` 自愈；
 * - 扩容请求失败或等待文件系统生效超时一律记录告警、写入有界短冷却并 fail-open，不阻断正常业务。
 */
export async function ensureSandboxPvcCapacity(params: {
  sandbox: SandboxDiskProbeClient;
  incomingBytes?: number;
  signal?: AbortSignal;
  rethrowRecoverable?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  if (!isAgentSandboxDynamicPvcResizeEnabled()) {
    return;
  }
  const claimName = params.sandbox.workspaceClaimName;
  if (!claimName) {
    return;
  }

  throwIfAborted(params.signal);
  if (isInResizeCooldown(claimName)) {
    return;
  }

  // 1. O(1) statvfs 实时查询挂载卷容量与可用空间。
  let initialUsage;
  try {
    initialUsage = await getSandboxDiskUsage({
      sandbox: params.sandbox,
      scope: 'filesystem',
      signal: params.signal
    });
  } catch (error) {
    if (params.signal?.aborted || (params.rethrowRecoverable && isRecoverableSandboxError(error))) {
      throw error;
    }
    logger.warn('[Sandbox PvcResize] Failed to probe sandbox filesystem usage, failing open', {
      sandboxId: params.sandbox.id,
      claimName,
      error
    });
    return;
  }

  const filesystem = initialUsage.filesystem;
  if (!filesystem) {
    return;
  }

  // 2. 计算是否满足扩容阈值与按 0.5Gi 对齐的目标容量。
  const maxStorageSizeGi = getAgentSandboxCommonConfig().storageSizeGi;
  const plan = computeTargetPvcResizePlan({
    filesystem,
    maxStorageSizeGi,
    incomingBytes: params.incomingBytes
  });
  if (!plan.shouldResize) {
    return;
  }

  // 已知待写入体积大于当前真实可用空间时，不等待扩容生效必然触达 ENOSPC，改用阻塞等待上限覆盖 kubelet 60s 同步周期；
  // 否则仍存在余量缓冲（如 200MiB 水位内的小写入），仅短等待 10s 后 fail-open 放行，让 kubelet 后台完成在线扩容。
  const requiresBlockingWait =
    typeof params.incomingBytes === 'number' &&
    Number.isFinite(params.incomingBytes) &&
    params.incomingBytes > filesystem.availableBytes;
  const waitTimeoutMs =
    params.waitTimeoutMs ??
    (requiresBlockingWait
      ? SANDBOX_PVC_RESIZE_BLOCKING_WAIT_TIMEOUT_MS
      : SANDBOX_PVC_RESIZE_WAIT_TIMEOUT_MS);
  const pollIntervalMs =
    params.pollIntervalMs ??
    (requiresBlockingWait
      ? SANDBOX_PVC_RESIZE_BLOCKING_POLL_INTERVAL_MS
      : SANDBOX_PVC_RESIZE_POLL_INTERVAL_MS);
  let beforeTotalBytes = filesystem.totalBytes;
  let targetStorageSize = plan.targetStorageSize;
  let expectedDeltaBytes = Math.max(1, (plan.targetMiB - plan.currentAllocatedMiB) * MIB_BYTES);

  // 3. 提交幂等 PVC PATCH 并同步短等待文件系统在线扩容生效。
  try {
    let resizeResult = await resizeSessionVolume(claimName, {
      storageSize: targetStorageSize,
      signal: params.signal
    });
    if (!resizeResult.resized) {
      const { requestedBytes, capacityBytes } = await readAuthoritativePvcBytes({
        claimName,
        resizeResult,
        signal: params.signal
      });
      if (
        isPvcAtMaxCapacity({ requestedBytes, capacityBytes, maxBytes: plan.maxMiB * MIB_BYTES })
      ) {
        return;
      }

      // PVC 声明与容量已同步但仍未达上限：重探一次 O(1) statvfs 区分「并发扩容刚落地」与「>=26GiB ext4 元数据低估」。
      if (
        capacityBytes !== undefined &&
        requestedBytes !== undefined &&
        capacityBytes >= requestedBytes
      ) {
        const latestUsage = await getSandboxDiskUsage({
          sandbox: params.sandbox,
          scope: 'filesystem',
          signal: params.signal
        }).catch((error) => {
          if (params.signal?.aborted) {
            throw error;
          }
          return undefined;
        });
        throwIfAborted(params.signal);

        const latestFs = latestUsage?.filesystem;
        if (latestFs) {
          if (
            latestFs.totalBytes >=
            beforeTotalBytes + computeRequiredGrowthBytes(expectedDeltaBytes)
          ) {
            return;
          }
          const actualPvcBytes = Math.max(requestedBytes, capacityBytes);
          const correctedPlan = computeTargetPvcResizePlan({
            filesystem: latestFs,
            maxStorageSizeGi,
            incomingBytes: params.incomingBytes,
            authoritativeAllocatedBytes: actualPvcBytes
          });
          if (
            !correctedPlan.shouldResize ||
            correctedPlan.targetMiB * MIB_BYTES <= requestedBytes
          ) {
            return;
          }

          beforeTotalBytes = latestFs.totalBytes;
          targetStorageSize = correctedPlan.targetStorageSize;
          expectedDeltaBytes = Math.max(1, correctedPlan.targetMiB * MIB_BYTES - actualPvcBytes);
          resizeResult = await resizeSessionVolume(claimName, {
            storageSize: targetStorageSize,
            signal: params.signal
          });
        }
      }
    }

    logger.info('[Sandbox PvcResize] Requested PVC online expansion', {
      sandboxId: params.sandbox.id,
      claimName,
      currentAllocatedMiB: plan.currentAllocatedMiB,
      targetStorageSize,
      patched: resizeResult.resized
    });

    const afterTotalBytes = await waitForFilesystemExpansion({
      sandbox: params.sandbox,
      beforeTotalBytes,
      expectedDeltaBytes,
      incomingBytes: params.incomingBytes,
      waitTimeoutMs,
      pollIntervalMs,
      signal: params.signal
    });
    if (afterTotalBytes !== undefined) {
      failedResizeUntilByClaim.delete(claimName);
      logger.info('[Sandbox PvcResize] PVC online expansion became visible in container', {
        sandboxId: params.sandbox.id,
        claimName,
        beforeTotalBytes,
        afterTotalBytes,
        targetStorageSize
      });
      return;
    }

    recordFailedResizeCooldown(claimName);
    logger.warn('[Sandbox PvcResize] Timed out waiting for resized filesystem in container', {
      sandboxId: params.sandbox.id,
      claimName,
      beforeTotalBytes,
      targetStorageSize,
      waitTimeoutMs
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw error;
    }
    recordFailedResizeCooldown(claimName);
    logger.warn('[Sandbox PvcResize] Failed to expand PVC, failing open', {
      sandboxId: params.sandbox.id,
      claimName,
      targetStorageSize,
      error
    });
  }
}
