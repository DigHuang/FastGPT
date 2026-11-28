import { readFileSync } from 'fs';
import { Agent } from 'undici';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  SandboxVolumeNameSchema,
  SandboxVolumePvcConditionSchema,
  type SandboxVolumeEnsureRequest,
  type SandboxVolumeEnsureResponse,
  type SandboxVolumeInspectResponse,
  type SandboxVolumePvcCondition,
  type SandboxVolumeResizeRequest,
  type SandboxVolumeResizeResponse
} from '@fastgpt/global/core/ai/sandbox/volume';
import type { IVolumeDriver } from './IVolumeDriver';
import { env } from '../env';
import { getLogger, LogCategories } from '../utils/logger';
import { FASTGPT_VOLUME_LABELS, canAdoptLegacyLabels, isManagedLabels } from '../utils/ownership';

const logger = getLogger(LogCategories.MODULE.VOLUME_MANAGER.DRIVER);

const K8S_API = 'https://kubernetes.default.svc';
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const DEFAULT_PVC_STORAGE_SIZE = '1Gi';
const DEFAULT_PVC_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PVC_POLL_INTERVAL_MS = 500;
const MAX_RESIZE_CONFLICT_ATTEMPTS = 5;

const K8S_UNIT_BYTES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15
};

/** 将 Kubernetes storage quantity（如 `512Mi`、`1Gi`、`1e9`）解析为正字节数；格式非法返回 `undefined`。 */
const parseK8sStorageBytes = (quantity?: string): number | undefined => {
  const raw = quantity?.trim();
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/.exec(raw);
  const bytes = match
    ? Math.round(Number(match[1]) * (match[2] ? K8S_UNIT_BYTES[match[2]] : 1))
    : /^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(raw)
      ? Math.round(Number(raw))
      : NaN;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

const K8sPvcSchema = z.object({
  metadata: z.object({
    name: z.string().min(1).optional(),
    uid: z.string().min(1),
    resourceVersion: z.string().min(1).optional(),
    deletionTimestamp: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()).optional()
  }),
  spec: z
    .object({
      resources: z
        .object({
          requests: z
            .object({
              storage: z.string().optional()
            })
            .optional()
        })
        .optional()
    })
    .optional(),
  status: z
    .object({
      capacity: z
        .object({
          storage: z.string().optional()
        })
        .optional(),
      conditions: z.array(SandboxVolumePvcConditionSchema).optional()
    })
    .optional()
});

const K8sPvcListSchema = z.object({
  items: z.array(K8sPvcSchema)
});

type K8sPvcDetails = {
  uid: string;
  resourceVersion?: string;
  managed: boolean;
  legacyAdoptable: boolean;
  requestedBytes?: number;
  capacityBytes?: number;
  conditions?: SandboxVolumePvcCondition[];
};

type K8sPvcState =
  | { state: 'absent' }
  | ({ state: 'active' } & K8sPvcDetails)
  | ({ state: 'deleting' } & K8sPvcDetails);

export type K8sVolumeDriverOptions = {
  namespace?: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
};

export class K8sVolumeDriver implements IVolumeDriver {
  private readonly namespace: string;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private dispatcher?: Agent;

  constructor(options: K8sVolumeDriverOptions = {}) {
    this.namespace = options.namespace ?? env.VM_K8S_NAMESPACE;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_PVC_WAIT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PVC_POLL_INTERVAL_MS;

    if (this.waitTimeoutMs <= 0 || this.pollIntervalMs <= 0) {
      throw new Error('K8s PVC wait timeout and poll interval must be positive');
    }
  }

  private k8sFetch(url: string, init: RequestInit = {}): Promise<Response> {
    // Kubernetes in-cluster CA 是服务账号挂载文件，按实例懒加载，避免模块初始化依赖运行环境。
    this.dispatcher ??= new Agent({ connect: { ca: readFileSync(CA_PATH, 'utf-8') } });
    const token = readFileSync(TOKEN_PATH, 'utf-8').trim();
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...init.headers
      },
      signal: AbortSignal.timeout(30_000),
      dispatcher: this.dispatcher
    } as RequestInit & { dispatcher: Agent });
  }

  private pvcUrl(name?: string): string {
    const base = `${K8S_API}/api/v1/namespaces/${this.namespace}/persistentvolumeclaims`;
    return name ? `${base}/${name}` : base;
  }

  /** 提取 PVC 的声明容量与实际容量字节数，供 inspect / resize 响应复用。 */
  private pickStorageFields(
    details: Pick<K8sPvcDetails, 'requestedBytes' | 'capacityBytes'>
  ): Pick<SandboxVolumeResizeResponse, 'requestedBytes' | 'capacityBytes'> {
    return {
      ...(details.requestedBytes !== undefined ? { requestedBytes: details.requestedBytes } : {}),
      ...(details.capacityBytes !== undefined ? { capacityBytes: details.capacityBytes } : {})
    };
  }

  /** 从已校验的 K8s PVC 对象提取归属、版本、容量字节数与扩容状态条件。 */
  private extractPvcDetails(parsed: z.infer<typeof K8sPvcSchema>): K8sPvcDetails {
    return {
      uid: parsed.metadata.uid,
      ...(parsed.metadata.resourceVersion
        ? { resourceVersion: parsed.metadata.resourceVersion }
        : {}),
      managed: isManagedLabels(parsed.metadata.labels),
      legacyAdoptable: canAdoptLegacyLabels(parsed.metadata.labels),
      ...this.pickStorageFields({
        requestedBytes: parseK8sStorageBytes(parsed.spec?.resources?.requests?.storage),
        capacityBytes: parseK8sStorageBytes(parsed.status?.capacity?.storage)
      }),
      ...(parsed.status?.conditions?.length ? { conditions: parsed.status.conditions } : {})
    };
  }

  /** 读取 PVC 的 generation、容量状态和删除状态，避免把 Terminating 对象当成可挂载资源。 */
  private async readPvc(name: string): Promise<K8sPvcState> {
    const url = this.pvcUrl(name);
    const res = await this.k8sFetch(url);
    logger.debug('K8s GET PVC', { url, status: res.status });

    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { state: 'absent' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`K8s PVC GET failed (${res.status}): ${text}`);
    }

    const body: unknown = await res.json();
    const parsed = K8sPvcSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`K8s PVC GET returned invalid metadata for ${this.namespace}/${name}`);
    }
    const details = this.extractPvcDetails(parsed.data);
    return parsed.data.metadata.deletionTimestamp
      ? { state: 'deleting', ...details }
      : { state: 'active', ...details };
  }

  /**
   * 等待目标 PVC generation 结束。
   *
   * 同名对象 UID 变化表示旧 generation 已完成删除；此时必须停止等待，不能继续操作新 PVC。
   */
  private async waitForPvcGenerationEnd(params: {
    name: string;
    uid: string;
    deadline: number;
  }): Promise<void> {
    while (true) {
      const current = await this.readPvc(params.name);
      if (current.state === 'absent' || current.uid !== params.uid) return;

      await this.waitForPoll(
        params.deadline,
        `Timed out waiting for K8s PVC ${this.namespace}/${params.name} uid=${params.uid} to be deleted`
      );
    }
  }

  private async waitForPoll(deadline: number, timeoutMessage: string): Promise<void> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new HTTPException(504, { message: timeoutMessage });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remainingMs)));
  }

  private assertPvcOwnership({
    name,
    current,
    allowLegacyUnlabeled
  }: {
    name: string;
    current: Exclude<K8sPvcState, { state: 'absent' }>;
    allowLegacyUnlabeled?: boolean;
  }): void {
    // [4.18.0 legacy compat, remove in >= 4.19.0] allowLegacyUnlabeled && legacyAdoptable 允许接管/清理无标签历史 PVC
    if (!current.managed && !(allowLegacyUnlabeled && current.legacyAdoptable)) {
      throw new HTTPException(403, {
        message: `Refusing to manage K8s PVC ${this.namespace}/${name}: missing fastgpt-volume-manager ownership labels`
      });
    }
  }

  /** 只读查询活跃 PVC 的容量与状态条件（绝不触发新建 PVC）。 */
  async inspect(
    name: string,
    options?: { allowLegacyUnlabeled?: boolean }
  ): Promise<SandboxVolumeInspectResponse | null> {
    const current = await this.readPvc(name);
    if (current.state === 'absent') return null;
    this.assertPvcOwnership({
      name,
      current,
      allowLegacyUnlabeled: options?.allowLegacyUnlabeled
    });
    if (current.state !== 'active') return null;
    return {
      claimName: name,
      ...this.pickStorageFields(current),
      ...(current.conditions ? { conditions: current.conditions } : {})
    };
  }

  /**
   * 幂等扩容已托管 PVC 的 `spec.resources.requests.storage`。
   *
   * 若当前声明容量已满足或大于目标容量，直接幂等返回 `resized: false`（禁止缩容）；
   * PATCH 携带 `metadata.resourceVersion` 乐观锁并在 `409 Conflict` 时有界重试，防止 K8s 1.27+
   * `RecoverVolumeExpansionFailure` 场景下并发较小请求静默回退已提交的更大扩容目标。
   */
  async resize(
    name: string,
    params: SandboxVolumeResizeRequest
  ): Promise<SandboxVolumeResizeResponse> {
    const targetBytes = parseK8sStorageBytes(params.storageSize);
    if (targetBytes === undefined) {
      throw new HTTPException(400, {
        message: `Invalid K8s PVC storageSize: ${params.storageSize}`
      });
    }

    const patchUrl = this.pvcUrl(name);

    for (let attempt = 1; attempt <= MAX_RESIZE_CONFLICT_ATTEMPTS; attempt += 1) {
      const current = await this.readPvc(name);
      if (current.state === 'absent') {
        throw new HTTPException(404, {
          message: `K8s PVC ${this.namespace}/${name} not found`
        });
      }
      this.assertPvcOwnership({ name, current });
      if (current.state === 'deleting') {
        throw new HTTPException(409, {
          message: `K8s PVC ${this.namespace}/${name} is terminating`
        });
      }

      if (current.requestedBytes !== undefined && current.requestedBytes >= targetBytes) {
        return {
          claimName: name,
          resized: false,
          ...this.pickStorageFields(current)
        };
      }

      const patchRes = await this.k8sFetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/merge-patch+json'
        },
        body: JSON.stringify({
          ...(current.resourceVersion
            ? { metadata: { resourceVersion: current.resourceVersion } }
            : {}),
          spec: {
            resources: {
              requests: {
                storage: params.storageSize
              }
            }
          }
        })
      });
      logger.debug('K8s PATCH PVC resize', {
        url: patchUrl,
        claimName: name,
        storageSize: params.storageSize,
        attempt,
        status: patchRes.status
      });

      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => '');
        // 乐观锁冲突（409）：重读最新 PVC；若并发更大请求已胜出则幂等返回 resized: false，若较小请求胜出则用新 resourceVersion 重试。
        if (patchRes.status === 409 && attempt < MAX_RESIZE_CONFLICT_ATTEMPTS) {
          continue;
        }
        if (
          patchRes.status === 400 ||
          patchRes.status === 403 ||
          patchRes.status === 404 ||
          patchRes.status === 409 ||
          patchRes.status === 422
        ) {
          throw new HTTPException(patchRes.status, {
            message: `K8s PVC resize failed (${patchRes.status}): ${text}`
          });
        }
        throw new Error(`K8s PVC resize failed (${patchRes.status}): ${text}`);
      }

      const rawBody: unknown = await patchRes.json().catch(() => null);
      const parsed = K8sPvcSchema.safeParse(rawBody);
      if (!parsed.success) {
        return {
          claimName: name,
          resized: true,
          requestedBytes: targetBytes
        };
      }

      const updated = this.extractPvcDetails(parsed.data);
      return {
        claimName: name,
        resized: true,
        ...this.pickStorageFields(updated)
      };
    }

    throw new HTTPException(409, {
      message: `K8s PVC ${this.namespace}/${name} resize conflict exceeded retry limit`
    });
  }

  async ensure(params: SandboxVolumeEnsureRequest): Promise<SandboxVolumeEnsureResponse> {
    const name = params.claimName;
    const storageSize = params.storageSize ?? DEFAULT_PVC_STORAGE_SIZE;
    const deadline = Date.now() + this.waitTimeoutMs;

    while (true) {
      const current = await this.readPvc(name);
      if (current.state !== 'absent') {
        this.assertPvcOwnership({
          name,
          current
        });
      }
      if (current.state === 'active') {
        return { claimName: name, created: false };
      }
      if (current.state === 'deleting') {
        await this.waitForPvcGenerationEnd({ name, uid: current.uid, deadline });
        continue;
      }

      const pvcPayload = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name,
          namespace: this.namespace,
          labels: { ...FASTGPT_VOLUME_LABELS }
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: storageSize } },
          ...(env.VM_K8S_PVC_STORAGE_CLASS
            ? { storageClassName: env.VM_K8S_PVC_STORAGE_CLASS }
            : {})
        }
      };

      const postUrl = this.pvcUrl();
      const createRes = await this.k8sFetch(postUrl, {
        method: 'POST',
        body: JSON.stringify(pvcPayload)
      });
      logger.debug('K8s POST PVC', { url: postUrl, claimName: name, status: createRes.status });

      if (createRes.ok) {
        await createRes.body?.cancel().catch(() => undefined);
        return { claimName: name, created: true };
      }
      if (createRes.status === 409) {
        await createRes.body?.cancel().catch(() => undefined);
        await this.waitForPoll(deadline, `Timed out ensuring K8s PVC ${this.namespace}/${name}`);
        continue;
      }

      const text = await createRes.text().catch(() => '');
      throw new Error(`K8s PVC create failed (${createRes.status}): ${text}`);
    }
  }

  async remove(name: string, options?: { allowLegacyUnlabeled?: boolean }): Promise<void> {
    const current = await this.readPvc(name);
    if (current.state === 'absent') return;
    this.assertPvcOwnership({
      name,
      current,
      allowLegacyUnlabeled: options?.allowLegacyUnlabeled
    });

    const targetUid = current.uid;
    const deadline = Date.now() + this.waitTimeoutMs;
    if (current.state === 'deleting') {
      await this.waitForPvcGenerationEnd({ name, uid: targetUid, deadline });
      return;
    }

    const delUrl = this.pvcUrl(name);

    const res = await this.k8sFetch(delUrl, {
      method: 'DELETE',
      body: JSON.stringify({
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid: targetUid }
      })
    });
    logger.debug('K8s DELETE PVC', { url: delUrl, status: res.status });

    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 409) {
      const text = await res.text().catch(() => '');
      const latest = await this.readPvc(name);
      if (latest.state === 'absent' || latest.uid !== targetUid) return;
      throw new HTTPException(409, { message: `K8s PVC delete failed (${res.status}): ${text}` });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`K8s PVC delete failed (${res.status}): ${text}`);
    }
    await res.body?.cancel().catch(() => undefined);

    await this.waitForPvcGenerationEnd({ name, uid: targetUid, deadline });
  }

  /** 列出由 fastgpt-volume-manager 管理的活跃 PVC 名称（跳过正在删除与标签不匹配的 PVC）。 */
  async list(): Promise<string[]> {
    const labelSelector = encodeURIComponent(
      `app=${FASTGPT_VOLUME_LABELS.app},managed-by=${FASTGPT_VOLUME_LABELS['managed-by']}`
    );
    const url = `${this.pvcUrl()}?labelSelector=${labelSelector}`;
    const res = await this.k8sFetch(url);
    logger.debug('K8s LIST PVC', { url, status: res.status });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`K8s PVC LIST failed (${res.status}): ${text}`);
    }

    const body: unknown = await res.json();
    const parsed = K8sPvcListSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`K8s PVC LIST returned invalid metadata for ${this.namespace}`);
    }

    return parsed.data.items.flatMap((item) => {
      const { name, deletionTimestamp } = item.metadata;
      if (deletionTimestamp || !name || !SandboxVolumeNameSchema.safeParse(name).success) {
        return [];
      }
      return [name];
    });
  }
}
