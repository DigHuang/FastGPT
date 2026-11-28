/**
 * 管理后台端到端实测 Kubernetes 动态 PVC 在线扩容能力。
 *
 * 完整验证路径：
 * 1. 创建 512Mi 临时 PVC（验证最小建卷支持）；
 * 2. 通过隔离连接的 OpenSandbox 客户端启动轻量临时 Pod 挂载该 PVC（穿透 WaitForFirstConsumer），
 *    并读取容器内 statvfs 初始容量；
 * 3. 校验初始实际容量未被后端云盘隐式大幅拉大（> 900MiB 判定 min_size_too_large）；
 * 4. 执行 512Mi -> 1024Mi 在线扩容并轮询验证文件系统容量即时增长
 *    （依据权威信号识别 RBAC 403、SC 403、持续 FileSystemResizePending 与超时）；
 * 5. finally 阶段带短超时强制删除临时 Pod 与临时 PVC，并关闭隔离连接 transport。
 */
import { randomUUID } from 'node:crypto';
import z from 'zod';
import { LeaseCache, RedisLeaseUnavailableError } from '@fastgpt/dal/redis/caches';
import { getErrorMessage } from '@fastgpt/global/common/error/utils';
import { replaceSensitiveText } from '@fastgpt/global/common/string/tools';
import { delayWithSignal, throwIfAborted } from '@fastgpt/global/common/system/utils';
import { DEFAULT_SANDBOX_VOLUME_NAME_PREFIX } from '@fastgpt/global/common/system/config/schemas/subservice';
import type {
  TestSandboxPvcResizeErrorCode,
  TestSandboxPvcResizeResponse
} from '@fastgpt/global/openapi/admin/system/instanceConfig/testSandboxPvcResize';
import { getLogger, LogCategories } from '../../../../../common/logger';
import { getAgentSandboxOpenSandboxConfig } from '../../config';
import { SANDBOX_PVC_RESIZE_INITIAL_MIB, SANDBOX_PVC_RESIZE_STEP_MIB } from '../../constants';
import {
  createRuntimeOpenSandboxClient,
  disconnectSandbox,
  type OpenSandboxClient
} from '../../infrastructure/opensandbox/opensandbox';
import {
  buildBaseSandboxRuntimeEnv,
  buildOpenSandboxCreateConfig
} from '../../infrastructure/opensandbox/runtimeProfile';
import type { VolumeManagerConfig } from '../../infrastructure/volume/config';
import {
  VolumeManagerHttpError,
  buildVolumeConfig,
  deleteSessionVolume,
  ensureSessionVolume,
  inspectSessionVolume,
  resizeSessionVolume
} from '../../infrastructure/volume/service';
import { getSandboxDiskUsage } from '../ideAgent';

const logger = getLogger(LogCategories.MODULE.AI.SANDBOX);
const probeLeaseCache = new LeaseCache();

const PVC_RESIZE_PROBE_LEASE_KEY = 'agent-sandbox:pvc-resize-probe';
const PVC_RESIZE_PROBE_LEASE_TTL_MS = 30_000;
const PVC_RESIZE_PROBE_LEASE_RENEW_MS = 5_000;

const MIB_BYTES = 1024 * 1024;
/** 建 512Mi 卷若实际挂载出来超过 900MiB，说明存储后端强制放大到了 >=1Gi（如云盘最小卷限制）。 */
const MAX_ACCEPTED_INITIAL_BYTES = 900 * MIB_BYTES;
/** 扩容 +512Mi 后，文件系统可见容量至少增长 256MiB 才视为真实在线生效。 */
const MIN_EXPECTED_RESIZE_DELTA_BYTES = 256 * MIB_BYTES;
/** 覆盖标准 Kubernetes kubelet 默认 60s 卷同步周期 + CSI 控制器扩盘耗时，避免误把正常在线 CSI 判成离线。 */
const RESIZE_VERIFY_TIMEOUT_MS = 100_000;
const PROBE_POLL_INTERVAL_MS = 1_000;
const PROBE_INITIAL_DISK_PROBE_MAX_ATTEMPTS = 5;
const PROBE_SANDBOX_READY_TIMEOUT_SECONDS = 90;
/** 临时探测 Pod 兜底生命周期（300s）：覆盖 90s 就绪 + 100s 扩容校验与清理余量，防止进程异常或草稿探测永久泄漏 Pod 与锁死 PVC。 */
const PROBE_SANDBOX_TTL_SECONDS = 300;
const PROBE_CLEANUP_TIMEOUT_MS = 15_000;
const PROBE_RESOURCE_LIMITS = { cpuCount: 0.5, memoryMiB: 512 } as const;

const EXPANSION_DISABLED_ERROR_RE =
  /allowVolumeExpansion|must\s+support\s+resize|only\s+dynamically\s+provisioned\s+pvc\s+can\s+be\s+resized|does\s+not\s+support\s+(?:volume\s+)?expansion/i;

const ReadableJsonErrorSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional()
});

export type TestSandboxPvcResizeInput = {
  baseUrl: string;
  apiKey: string;
  image: string;
  useServerProxy: boolean;
  volumeManagerUrl: string;
  volumeManagerToken: string;
  volumeNamePrefix?: string;
};

type ResizeStepResult =
  | { ok: true; totalBytes: number }
  | { ok: false; errorCode: TestSandboxPvcResizeErrorCode; error: string };

/** 从 JSON 文本中提取可读错误文案，避免把 K8s Status 等原始 JSON 结构透传到前端。 */
const extractReadableJsonError = (text: string): string | undefined => {
  try {
    const parsed = ReadableJsonErrorSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    for (const candidate of [parsed.data.message, parsed.data.error]) {
      if (candidate?.trim()) {
        return candidate.trim();
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/** 对齐 testDocumentParse 脱敏口径：剥离本次提交密钥、Bearer Token、敏感内网信息与原始 JSON 错误体。 */
const sanitizeProbeError = ({
  error,
  secrets,
  fallback
}: {
  error: unknown;
  secrets: Array<string | undefined>;
  fallback: string;
}): string => {
  const rawMessage = (() => {
    if (error instanceof VolumeManagerHttpError) {
      const trimmedBody = error.body.trim();
      if (!trimmedBody) return `Volume Manager request failed (HTTP ${error.status})`;

      const unpackedBody = trimmedBody.startsWith('{')
        ? (extractReadableJsonError(trimmedBody) ??
          `Volume Manager request failed (HTTP ${error.status})`)
        : trimmedBody;
      // volume-manager 转发 K8s 报错时常在前缀后拼接原始 K8s Status JSON，拆出其中 message 即可。
      const jsonStart = unpackedBody.indexOf('{');
      if (jsonStart !== -1) {
        const prefix = unpackedBody.slice(0, jsonStart).trim().replace(/:\s*$/, '');
        const nestedMessage = extractReadableJsonError(unpackedBody.slice(jsonStart));
        if (nestedMessage) {
          return prefix ? `${prefix}: ${nestedMessage}` : nestedMessage;
        }
        return prefix || `Volume Manager request failed (HTTP ${error.status})`;
      }
      return unpackedBody;
    }

    return getErrorMessage(error, '').trim() || fallback;
  })();

  let sanitized = rawMessage;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join('***');
    }
  }
  sanitized = sanitized.replace(/\bBearer\s+\S+/gi, 'Bearer ***');
  sanitized = replaceSensitiveText(sanitized).trim();
  if (!sanitized) return fallback;
  return sanitized.length > 300 ? `${sanitized.slice(0, 300)}...` : sanitized;
};

const classifyResizePatchError = ({
  error,
  secrets
}: {
  error: unknown;
  secrets: Array<string | undefined>;
}): { errorCode: TestSandboxPvcResizeErrorCode; error: string } => {
  if (error instanceof VolumeManagerHttpError) {
    // K8s PersistentVolumeClaimResize admission 在 StorageClass 未开启 allowVolumeExpansion 时返回 HTTP 403 Forbidden，
    // 必须先于通用 403 RBAC 判定识别；未绑定 PVC 的 422（spec is immutable... for bound claims）则走通用 failed。
    if (EXPANSION_DISABLED_ERROR_RE.test(error.body)) {
      return {
        errorCode: 'expansion_not_allowed',
        error: sanitizeProbeError({
          error,
          secrets,
          fallback: 'StorageClass does not allow volume expansion'
        })
      };
    }
    if (error.status === 403) {
      return {
        errorCode: 'rbac_denied',
        error:
          'Volume Manager lacks Kubernetes RBAC patch permission on persistentvolumeclaims (403)'
      };
    }
  }

  return {
    errorCode: 'failed',
    error: sanitizeProbeError({
      error,
      secrets,
      fallback:
        error instanceof VolumeManagerHttpError
          ? `PVC resize failed (HTTP ${error.status})`
          : 'Failed to patch PVC size'
    })
  };
};

/** 执行 512Mi -> 1024Mi 在线扩容并轮询容器内 `statvfs`，超时后再核对 PVC 条件区分离线扩容与通用超时。 */
async function executeAndVerifyOnlineResize(params: {
  sandbox: OpenSandboxClient;
  claimName: string;
  targetStorageSize: string;
  beforeTotalBytes: number;
  vmConfig: VolumeManagerConfig;
  secrets: Array<string | undefined>;
  signal: AbortSignal;
}): Promise<ResizeStepResult> {
  try {
    await resizeSessionVolume(params.claimName, {
      storageSize: params.targetStorageSize,
      vmConfig: params.vmConfig,
      signal: params.signal
    });
  } catch (error) {
    if (params.signal.aborted) {
      throw error;
    }
    return {
      ok: false,
      ...classifyResizePatchError({ error, secrets: params.secrets })
    };
  }

  const deadline = Date.now() + RESIZE_VERIFY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await delayWithSignal(
      Math.min(PROBE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())),
      params.signal
    );

    const latestUsage = await getSandboxDiskUsage({
      sandbox: params.sandbox,
      scope: 'filesystem',
      signal: params.signal
    }).catch((error) => {
      if (params.signal.aborted) {
        throw error;
      }
      return undefined;
    });
    throwIfAborted(params.signal);

    if (
      latestUsage?.filesystem &&
      latestUsage.filesystem.totalBytes >= params.beforeTotalBytes + MIN_EXPECTED_RESIZE_DELTA_BYTES
    ) {
      return { ok: true, totalBytes: latestUsage.filesystem.totalBytes };
    }
  }

  // 在线 CSI 在 ControllerExpandVolume 与 kubelet NodeExpandVolume 之间同样会短暂进入 FileSystemResizePending；
  // 仅在完整等待超时后该条件仍持续存在时，才判定为仅支持离线扩容，避免健康云盘 CSI 误报。
  const inspected = await inspectSessionVolume(params.claimName, {
    vmConfig: params.vmConfig,
    signal: params.signal
  }).catch((error) => {
    if (params.signal.aborted) {
      throw error;
    }
    return undefined;
  });
  throwIfAborted(params.signal);

  const isOfflinePending = (inspected?.conditions ?? []).some(
    (cond) => cond.type === 'FileSystemResizePending' && cond.status === 'True'
  );
  if (isOfflinePending) {
    return {
      ok: false,
      errorCode: 'offline_resize_only',
      error:
        'CSI remained in FileSystemResizePending after timeout and requires Pod restart; online expansion is not supported'
    };
  }

  return {
    ok: false,
    errorCode: 'resize_timeout',
    error: `Timed out waiting for container filesystem to expand to ${params.targetStorageSize}`
  };
}

/**
 * 端到端实测当前 Kubernetes 集群的 Agent Sandbox 动态 PVC 在线扩容能力。
 *
 * 使用分布式租约防止并发拉起多个测试 Pod；无论成功与否均在 `finally` 带短超时清理临时 Pod 与 PVC。
 */
export async function testSandboxDynamicPvcResize(
  input: TestSandboxPvcResizeInput
): Promise<TestSandboxPvcResizeResponse> {
  const startTime = Date.now();
  const elapsedMs = () => Date.now() - startTime;
  const secrets = [input.apiKey, input.volumeManagerToken];
  const fail = (
    errorCode: TestSandboxPvcResizeErrorCode,
    error: string,
    initialBytes?: number
  ): TestSandboxPvcResizeResponse => ({
    supported: false,
    responseTimeMs: elapsedMs(),
    ...(initialBytes !== undefined ? { initialBytes } : {}),
    errorCode,
    error
  });
  const failSanitized = (error: unknown, fallback: string) =>
    fail('failed', sanitizeProbeError({ error, secrets, fallback }));

  try {
    return await probeLeaseCache.withLease({
      key: PVC_RESIZE_PROBE_LEASE_KEY,
      label: 'admin-test-sandbox-pvc-resize',
      ttlMs: PVC_RESIZE_PROBE_LEASE_TTL_MS,
      renewIntervalMs: PVC_RESIZE_PROBE_LEASE_RENEW_MS,
      fn: async (lease) => {
        const effectiveSignal = lease.signal;

        const volumeNamePrefix = (
          input.volumeNamePrefix?.trim() || DEFAULT_SANDBOX_VOLUME_NAME_PREFIX
        ).toLowerCase();
        const initialSizeMiB = SANDBOX_PVC_RESIZE_INITIAL_MIB;
        const targetSizeMiB = initialSizeMiB + SANDBOX_PVC_RESIZE_STEP_MIB;

        const probeSandboxId = `probe-pvc-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        // 命名遵守 MANAGED_SESSION_VOLUME_CLAIM_REST_RE（`<prefix>-<sandboxId>-0`），已保存配置下异常重启亦可由孤儿 GC 回收。
        const claimName = `${volumeNamePrefix}-${probeSandboxId}-0`;

        const vmConfig: VolumeManagerConfig = {
          url: input.volumeManagerUrl,
          token: input.volumeManagerToken,
          volumeNamePrefix,
          storageSize: `${initialSizeMiB}Mi`
        };

        let shouldCleanupVolume = false;
        let sandbox: OpenSandboxClient | undefined;

        try {
          // 1. 创建 512Mi 初始测试 PVC；发起前即标记待清理，避免超时/中止等结果未决异常遗留临时 PVC。
          shouldCleanupVolume = true;
          try {
            await ensureSessionVolume(claimName, {
              storageSize: `${initialSizeMiB}Mi`,
              vmConfig,
              signal: effectiveSignal
            });
          } catch (error) {
            if (error instanceof VolumeManagerHttpError && error.status < 500) {
              shouldCleanupVolume = false;
            }
            return failSanitized(error, 'Failed to create 512Mi test PVC');
          }

          // 2. 用隔离连接的 OpenSandbox 客户端启动轻量临时 Pod 挂载 PVC（穿透 WaitForFirstConsumer 绑定）。
          const clientConfig = {
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            runtime: 'kubernetes' as const,
            useServerProxy: input.useServerProxy
          };
          const volumes = buildVolumeConfig(claimName).volumes;
          const createConfig = buildOpenSandboxCreateConfig({
            opensandboxConfig: {
              ...getAgentSandboxOpenSandboxConfig(),
              ...clientConfig,
              image: input.image,
              volumeManagerUrl: input.volumeManagerUrl,
              volumeManagerToken: input.volumeManagerToken,
              volumeNamePrefix
            },
            resourceLimits: PROBE_RESOURCE_LIMITS,
            volumes,
            env: buildBaseSandboxRuntimeEnv({ runtime: 'kubernetes' }),
            createConfig: {
              readyTimeoutSeconds: PROBE_SANDBOX_READY_TIMEOUT_SECONDS,
              timeoutSeconds: PROBE_SANDBOX_TTL_SECONDS,
              metadata: {
                probe: 'pvc-resize'
              }
            }
          });
          sandbox = createRuntimeOpenSandboxClient({
            sandboxId: probeSandboxId,
            volumes,
            isolatedConnection: true,
            runtimeConfig: {
              clientConfig,
              image: createConfig.image,
              createConfig
            }
          });

          try {
            await sandbox.ensureRunning({ signal: effectiveSignal });
          } catch (error) {
            return failSanitized(error, 'Failed to start temporary test sandbox Pod');
          }

          // 3. 探查容器内 statvfs 初始容量，校验底层存储未隐式大幅放大初始卷。
          let initialBytes: number;
          try {
            const initialUsage = await getSandboxDiskUsage({
              sandbox,
              scope: 'filesystem',
              maxAttempts: PROBE_INITIAL_DISK_PROBE_MAX_ATTEMPTS,
              signal: effectiveSignal
            });
            if (!initialUsage.filesystem || initialUsage.filesystem.totalBytes <= 0) {
              return fail(
                'failed',
                'Sandbox ide-agent did not return filesystem statvfs metrics; upgrade sandbox image first'
              );
            }
            initialBytes = initialUsage.filesystem.totalBytes;
          } catch (error) {
            return failSanitized(error, 'Failed to probe filesystem usage inside sandbox');
          }

          if (initialBytes > MAX_ACCEPTED_INITIAL_BYTES) {
            return fail(
              'min_size_too_large',
              `Requested ${initialSizeMiB}Mi PVC was provisioned as ${Math.round(initialBytes / MIB_BYTES)}MiB; storage backend enforces a larger minimum volume size`,
              initialBytes
            );
          }

          // 4. 执行 512Mi -> 1024Mi 在线扩容并确认容器内文件系统实时增长。
          const resizeStep = await executeAndVerifyOnlineResize({
            sandbox,
            claimName,
            targetStorageSize: `${targetSizeMiB}Mi`,
            beforeTotalBytes: initialBytes,
            vmConfig,
            secrets,
            signal: effectiveSignal
          });
          if (!resizeStep.ok) {
            return fail(resizeStep.errorCode, resizeStep.error, initialBytes);
          }

          return {
            supported: true,
            responseTimeMs: elapsedMs(),
            initialBytes,
            resizedBytes: resizeStep.totalBytes
          };
        } finally {
          // 清理顺序：先删 Pod 解除 PVC 挂载，再删 PVC；均带短超时避免清理卡死长期占锁。
          if (sandbox) {
            await sandbox
              .delete({ signal: AbortSignal.timeout(PROBE_CLEANUP_TIMEOUT_MS) })
              .catch((err) => {
                logger.warn('[Sandbox PvcResizeProbe] Failed to delete temporary test Pod', {
                  sandboxId: probeSandboxId,
                  error: err
                });
              });
            await disconnectSandbox(sandbox);
          }
          if (shouldCleanupVolume) {
            await deleteSessionVolume(claimName, {
              vmConfig,
              signal: AbortSignal.timeout(PROBE_CLEANUP_TIMEOUT_MS)
            }).catch((err) => {
              logger.warn('[Sandbox PvcResizeProbe] Failed to delete temporary test PVC', {
                claimName,
                error: err
              });
            });
          }
        }
      }
    });
  } catch (error) {
    if (error instanceof RedisLeaseUnavailableError) {
      return fail('concurrent_test', 'Another PVC dynamic resize test is already running');
    }
    return failSanitized(error, 'PVC dynamic resize test failed unexpectedly');
  }
}
