/**
 * Kubernetes Agent Sandbox 动态 PVC 容量规划纯函数（无副作用、无 I/O）。
 *
 * 策略参数统一由 FastGPT 侧收敛：初始 `0.5Gi`（`512Mi`）、步长 `0.5Gi`（`512Mi`）、
 * 触发水位「使用率 >= 80% 且 剩余 < 200MiB」（或已知待写入 `incomingBytes` 会令剩余低于 200MiB），
 * 上限封顶为实例配置的 `storageSizeGi`。
 */
import { storageSizeGiToMiB } from '@fastgpt/global/core/ai/sandbox/constants';
import {
  SANDBOX_ARCHIVE_FALLBACK_COMPRESSION_RATIO,
  SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES,
  SANDBOX_PVC_RESIZE_INITIAL_MIB,
  SANDBOX_PVC_RESIZE_MIN_AVAILABLE_BYTES,
  SANDBOX_PVC_RESIZE_STEP_MIB,
  SANDBOX_PVC_RESIZE_USAGE_RATIO_THRESHOLD
} from '../../constants';
import type { SandboxFilesystemUsage } from '../ideAgent';

export const MIB_BYTES = 1024 * 1024;
export const STEP_BYTES = SANDBOX_PVC_RESIZE_STEP_MIB * MIB_BYTES;
/** 计入 ext4 静态元数据（~2%）与默认 root 预留块（5%）后的非特权用户可用空间倍率，避免多 GiB 写入/恢复仍因开销触达 ENOSPC。 */
const FS_OVERHEAD_MULTIPLIER = 1.08;

export type SandboxPvcResizePlan =
  | {
      shouldResize: false;
      currentAllocatedMiB: number;
      maxMiB: number;
    }
  | {
      shouldResize: true;
      currentAllocatedMiB: number;
      targetMiB: number;
      maxMiB: number;
      targetStorageSize: string;
    };

export const alignBytesToStepMiB = (bytes: number): number =>
  Math.ceil(bytes / STEP_BYTES) * SANDBOX_PVC_RESIZE_STEP_MIB;

/**
 * 计算容器内 `statvfs.totalBytes` 至少需要增长的字节数，作为本次 PVC 扩容已在线生效的判定门槛：
 * - 单步（<= 512Mi）或小数 `storageSizeGi` 尾步（< 32Mi）：按 `min(32Mi, expectedDelta / 2)` 放行；
 * - 多步扩容（> 512Mi）：按 `0.85 * expectedDelta` 兜底覆盖文件系统元数据开销，同时跨过中间步长避免被在途单步扩容提前唤醒。
 */
export const computeRequiredGrowthBytes = (expectedDeltaBytes: number): number => {
  if (expectedDeltaBytes <= 0) {
    return SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES;
  }
  if (expectedDeltaBytes <= STEP_BYTES) {
    return Math.min(
      SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES,
      Math.max(1, Math.floor(expectedDeltaBytes / 2))
    );
  }
  return Math.max(SANDBOX_PVC_RESIZE_EFFECTIVE_DELTA_BYTES, Math.floor(expectedDeltaBytes * 0.85));
};

export const isPvcAtMaxCapacity = (params: {
  requestedBytes?: number;
  capacityBytes?: number;
  maxBytes: number;
}): boolean =>
  params.capacityBytes !== undefined &&
  (params.capacityBytes >= params.maxBytes ||
    (params.requestedBytes !== undefined &&
      params.requestedBytes >= params.maxBytes &&
      params.capacityBytes >= params.requestedBytes));

/**
 * 计算归档恢复重建 PVC 时的目标容量（按 `0.5Gi` 整数倍向上对齐，封顶 `storageSizeGi`）。
 *
 * 优先使用归档前记录的占盘大小 `uncompressedBytes`；兼容无该字段的历史归档时按压缩包大小 4 倍保守估算。
 */
export function computeArchiveRestoreStorageSize(params: {
  maxStorageSizeGi: number;
  uncompressedBytes?: number;
  archiveSizeBytes: number;
}): string {
  const maxMiB = storageSizeGiToMiB(params.maxStorageSizeGi);
  const initialMiB = Math.min(SANDBOX_PVC_RESIZE_INITIAL_MIB, maxMiB);
  const estimatedUsedBytes =
    params.uncompressedBytes !== undefined
      ? params.uncompressedBytes
      : params.archiveSizeBytes * SANDBOX_ARCHIVE_FALLBACK_COMPRESSION_RATIO;
  if (estimatedUsedBytes <= 0) {
    return `${initialMiB}Mi`;
  }

  const rawRequiredBytes = estimatedUsedBytes + SANDBOX_PVC_RESIZE_MIN_AVAILABLE_BYTES;
  const requiredBytes = Math.ceil(rawRequiredBytes * FS_OVERHEAD_MULTIPLIER);
  const targetMiB = Math.min(maxMiB, alignBytesToStepMiB(requiredBytes));
  return `${Math.max(initialMiB, targetMiB)}Mi`;
}

/**
 * 纯函数：根据当前挂载点 `statvfs` 用量、全局上限与可选待写入大小，计算是否需要扩容及目标容量。
 */
export function computeTargetPvcResizePlan(params: {
  filesystem: SandboxFilesystemUsage;
  maxStorageSizeGi: number;
  incomingBytes?: number;
  /** 可选：来自 K8s PVC 的权威已分配字节数，用于大盘 ext4 元数据超过单步 512Mi 时校准基线。 */
  authoritativeAllocatedBytes?: number;
}): SandboxPvcResizePlan {
  const maxMiB = storageSizeGiToMiB(params.maxStorageSizeGi);
  const { totalBytes, availableBytes, usedBytes } = params.filesystem;
  if (totalBytes <= 0) {
    return { shouldResize: false, currentAllocatedMiB: 0, maxMiB };
  }

  const baseBytes = Math.max(totalBytes, params.authoritativeAllocatedBytes ?? 0);
  const currentAllocatedMiB = Math.min(
    maxMiB,
    Math.max(Math.min(SANDBOX_PVC_RESIZE_INITIAL_MIB, maxMiB), alignBytesToStepMiB(baseBytes))
  );
  if (currentAllocatedMiB >= maxMiB) {
    return { shouldResize: false, currentAllocatedMiB, maxMiB };
  }

  const incomingBytes =
    typeof params.incomingBytes === 'number' &&
    Number.isFinite(params.incomingBytes) &&
    params.incomingBytes > 0
      ? params.incomingBytes
      : 0;
  // 按非特权用户视角（与 df Use% 一致）计算使用率，使可用空间耗尽时自然达到 100%。
  const usableTotalBytes = usedBytes + availableBytes;
  const usedRatio = usableTotalBytes > 0 ? usedBytes / usableTotalBytes : 1;

  const hitsUsageThreshold =
    usedRatio >= SANDBOX_PVC_RESIZE_USAGE_RATIO_THRESHOLD &&
    availableBytes < SANDBOX_PVC_RESIZE_MIN_AVAILABLE_BYTES;
  const hitsIncomingBudget =
    incomingBytes > 0 && availableBytes - incomingBytes < SANDBOX_PVC_RESIZE_MIN_AVAILABLE_BYTES;

  if (!hitsUsageThreshold && !hitsIncomingBudget) {
    return { shouldResize: false, currentAllocatedMiB, maxMiB };
  }

  const rawDeficitBytes = Math.max(
    0,
    incomingBytes + SANDBOX_PVC_RESIZE_MIN_AVAILABLE_BYTES - availableBytes
  );
  const deficitBytes = Math.ceil(rawDeficitBytes * FS_OVERHEAD_MULTIPLIER);
  const stepsToAdd = Math.max(1, Math.ceil(deficitBytes / STEP_BYTES));
  const targetMiB = Math.min(
    maxMiB,
    currentAllocatedMiB + stepsToAdd * SANDBOX_PVC_RESIZE_STEP_MIB
  );

  return {
    shouldResize: true,
    currentAllocatedMiB,
    targetMiB,
    maxMiB,
    targetStorageSize: `${targetMiB}Mi`
  };
}
