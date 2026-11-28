import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const VOLUME_NAME = 'fastgpt-session-a1b2c3d4e5f6a1b2c3d4e5f6-generation';

vi.mock('../../src/env', () => ({
  env: {
    VM_K8S_NAMESPACE: 'opensandbox',
    VM_K8S_PVC_STORAGE_CLASS: ''
  }
}));

// Mock token and CA file reads
vi.mock('fs', () => ({
  readFileSync: vi.fn((path: string) => {
    if (path.endsWith('ca.crt')) return 'mock-ca-cert';
    return 'mock-token';
  })
}));

describe('K8sVolumeDriver', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const pvcResponse = ({
    uid,
    resourceVersion,
    deletionTimestamp,
    labels = {
      app: 'fastgpt',
      'managed-by': 'fastgpt-volume-manager'
    },
    requestedStorage,
    capacityStorage,
    conditions
  }: {
    uid: string;
    resourceVersion?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string> | null;
    requestedStorage?: string;
    capacityStorage?: string;
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  }) => ({
    ok: true,
    status: 200,
    json: async () => ({
      metadata: {
        uid,
        ...(resourceVersion ? { resourceVersion } : {}),
        ...(labels ? { labels } : {}),
        ...(deletionTimestamp ? { deletionTimestamp } : {})
      },
      ...(requestedStorage
        ? { spec: { resources: { requests: { storage: requestedStorage } } } }
        : {}),
      ...(capacityStorage || conditions
        ? {
            status: {
              ...(capacityStorage ? { capacity: { storage: capacityStorage } } : {}),
              ...(conditions ? { conditions } : {})
            }
          }
        : {})
    })
  });
  const notFoundResponse = () => ({ ok: false, status: 404, text: async () => '' });
  const errorResponse = (status: number, message: string) => ({
    ok: false,
    status,
    text: async () => message
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inspect checks PVC without creating and treats absent/deleting as null', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();

    fetchMock.mockResolvedValueOnce(notFoundResponse());
    await expect(driver.inspect(VOLUME_NAME)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-deleting', deletionTimestamp: '2026-07-30T00:00:00Z' })
    );
    await expect(driver.inspect(VOLUME_NAME)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-active' }));
    await expect(driver.inspect(VOLUME_NAME)).resolves.toEqual({ claimName: VOLUME_NAME });

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-legacy', labels: null }));
    await expect(driver.inspect(VOLUME_NAME)).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-legacy', labels: null }));
    await expect(driver.inspect(VOLUME_NAME, { allowLegacyUnlabeled: true })).resolves.toEqual({
      claimName: VOLUME_NAME
    });

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-foreign', labels: { app: 'other' } }));
    await expect(driver.inspect(VOLUME_NAME, { allowLegacyUnlabeled: true })).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('ensure returns created=false when PVC already exists', async () => {
    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    const result = await driver.ensure({ claimName: VOLUME_NAME });
    expect(result).toEqual({ claimName: VOLUME_NAME, created: false });
  });

  it('ensure creates PVC on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce({ ok: true, status: 201 });
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    const result = await driver.ensure({ claimName: VOLUME_NAME, storageSize: '5Gi' });
    const [, createOpts] = fetchMock.mock.calls[1];
    const body = JSON.parse((createOpts as any).body);

    expect(result).toEqual({ claimName: VOLUME_NAME, created: true });
    expect(body.spec.storageClassName).toBeUndefined();
    expect(body.spec.resources.requests.storage).toBe('5Gi');
    expect(body.metadata.namespace).toBe('opensandbox');
    expect(body.metadata.labels).toEqual({
      app: 'fastgpt',
      'managed-by': 'fastgpt-volume-manager'
    });

    const { env } = await import('../../src/env');
    env.VM_K8S_PVC_STORAGE_CLASS = 'fast-ssd';
    try {
      fetchMock
        .mockResolvedValueOnce(notFoundResponse())
        .mockResolvedValueOnce({ ok: true, status: 201 });
      await driver.ensure({ claimName: VOLUME_NAME, storageSize: '5Gi' });
      const [, explicitOpts] = fetchMock.mock.calls[3];
      const explicitBody = JSON.parse((explicitOpts as any).body);
      expect(explicitBody.spec.storageClassName).toBe('fast-ssd');
    } finally {
      env.VM_K8S_PVC_STORAGE_CLASS = '';
    }
  });

  it('ensure waits for a deleting PVC before creating the next generation', async () => {
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
      )
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
      )
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce({ ok: true, status: 201 });
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.ensure({ claimName: VOLUME_NAME })).resolves.toEqual({
      claimName: VOLUME_NAME,
      created: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('ensure reuses a replacement generation instead of creating another PVC', async () => {
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
      )
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-2' }))
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-2' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.ensure({ claimName: VOLUME_NAME })).resolves.toEqual({
      claimName: VOLUME_NAME,
      created: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ensure converges after a concurrent create returns 409', async () => {
    fetchMock
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(errorResponse(409, 'already exists'))
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.ensure({ claimName: VOLUME_NAME })).resolves.toEqual({
      claimName: VOLUME_NAME,
      created: false
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ensure throws on an unexpected create error', async () => {
    fetchMock
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(errorResponse(500, 'create failed'));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();

    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow('500');
  });

  it('ensure times out while concurrent create conflicts never settle', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? errorResponse(409, 'already exists') : notFoundResponse()
    );
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 1, pollIntervalMs: 1 });

    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow('Timed out ensuring');
  });

  it('ensure throws on unexpected GET error', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(403, 'forbidden'));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow('403');
  });

  it('ensure throws when an existing PVC response has no UID', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ metadata: {} })
    });
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow('invalid metadata');
  });

  it('fetch calls use an Undici dispatcher with ca.crt loaded', async () => {
    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const { readFileSync } = await import('fs');
    const driver = new K8sVolumeDriver();
    await driver.ensure({ claimName: VOLUME_NAME });
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts as any).dispatcher).toBeTruthy();
    expect(readFileSync).toHaveBeenCalledWith(
      '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
      'utf-8'
    );
  });

  it('remove treats 404 as success', async () => {
    fetchMock.mockResolvedValueOnce(notFoundResponse());
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
  });

  it('remove waits for the target UID to disappear after DELETE 202', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce({ ok: true, status: 202 })
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
      )
      .mockResolvedValueOnce(notFoundResponse());
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
    const [, deleteOptions] = fetchMock.mock.calls[1];
    expect(JSON.parse((deleteOptions as any).body)).toEqual({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: 'uid-1' }
    });
  });

  it('remove treats a DELETE 404 after reading the PVC as idempotent success', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce(notFoundResponse());
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();

    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
  });

  it('remove stops when the target UID was replaced', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce({ ok: true, status: 202 })
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-2' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
  });

  it('remove waits for an already deleting PVC', async () => {
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
      )
      .mockResolvedValueOnce(notFoundResponse());
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remove treats a UID precondition conflict after replacement as success', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce(errorResponse(409, 'uid precondition failed'))
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-2' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.remove(VOLUME_NAME)).resolves.toBeUndefined();
  });

  it('remove throws when a DELETE conflict still references the target UID', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce(errorResponse(409, 'conflict'))
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    await expect(driver.remove(VOLUME_NAME)).rejects.toThrow('409');
  });

  it('remove throws on unexpected DELETE error', async () => {
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1' }))
      .mockResolvedValueOnce(errorResponse(500, 'error'));
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    await expect(driver.remove(VOLUME_NAME)).rejects.toThrow('500');
  });

  it('ensure times out while a PVC generation remains deleting', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/persistentvolumeclaims/${VOLUME_NAME}`)) {
        return pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' });
      }
      return errorResponse(500, 'unexpected create');
    });
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 2, pollIntervalMs: 1 });

    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow('Timed out waiting');
  });

  it('list queries K8s PVCs with managed label selector and filters out deleting/invalid items', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            metadata: {
              name: VOLUME_NAME,
              uid: 'uid-1'
            }
          },
          {
            metadata: {
              name: 'fastgpt-session-deleting-pvc',
              uid: 'uid-2',
              deletionTimestamp: '2026-07-30T00:00:00Z'
            }
          },
          {
            metadata: {
              name: 'INVALID_PVC_NAME',
              uid: 'uid-3'
            }
          }
        ]
      })
    });

    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    const items = await driver.list();

    expect(items).toEqual([VOLUME_NAME]);
    const [listUrl] = fetchMock.mock.calls[0];
    expect(decodeURIComponent(String(listUrl))).toContain(
      'labelSelector=app=fastgpt,managed-by=fastgpt-volume-manager'
    );
  });

  it('ensure and remove refuse to touch existing PVCs lacking ownership labels', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();

    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-unmanaged', labels: { app: 'other' } })
    );
    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-unmanaged', labels: null }));
    await expect(driver.remove(VOLUME_NAME)).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remove deletes legacy unlabeled PVCs when allowLegacyUnlabeled=true while still rejecting foreign labels', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver({ waitTimeoutMs: 100, pollIntervalMs: 1 });

    fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-legacy', labels: null }));
    await expect(driver.ensure({ claimName: VOLUME_NAME })).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );

    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-legacy', labels: null }))
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(notFoundResponse());
    await expect(
      driver.remove(VOLUME_NAME, { allowLegacyUnlabeled: true })
    ).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-foreign', labels: { 'managed-by': 'helm' } })
    );
    await expect(driver.remove(VOLUME_NAME, { allowLegacyUnlabeled: true })).rejects.toThrow(
      'missing fastgpt-volume-manager ownership labels'
    );

    const foreignLabelCases: Record<string, string>[] = [
      { 'k8s-app': 'metrics-server' },
      { 'helm.sh/chart': 'redis-18.0.0' },
      { 'app.kubernetes.io/part-of': 'logging' },
      { 'com.docker.compose.service': 'worker' }
    ];
    for (const foreignLabels of foreignLabelCases) {
      fetchMock.mockResolvedValueOnce(pvcResponse({ uid: 'uid-foreign', labels: foreignLabels }));
      await expect(driver.inspect(VOLUME_NAME, { allowLegacyUnlabeled: true })).rejects.toThrow(
        'missing fastgpt-volume-manager ownership labels'
      );
    }
  });

  it('inspect returns PVC storage request, capacity, and conditions', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();

    fetchMock.mockResolvedValueOnce(
      pvcResponse({
        uid: 'uid-bound',
        requestedStorage: '512Mi',
        capacityStorage: '512Mi',
        conditions: [{ type: 'Resizing', status: 'True', message: 'expanding' }]
      })
    );

    await expect(driver.inspect(VOLUME_NAME)).resolves.toEqual({
      claimName: VOLUME_NAME,
      requestedBytes: 512 * 1024 * 1024,
      capacityBytes: 512 * 1024 * 1024,
      conditions: [{ type: 'Resizing', status: 'True', message: 'expanding' }]
    });
  });

  it('resize patches PVC storage monotonically, stays idempotent, and propagates 403/422 errors', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    const MIB = 1024 * 1024;

    // 1. 合法扩容：512Mi -> 1024Mi
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', requestedStorage: '512Mi', capacityStorage: '512Mi' })
      )
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', requestedStorage: '1024Mi', capacityStorage: '512Mi' })
      );
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: true,
      requestedBytes: 1024 * MIB,
      capacityBytes: 512 * MIB
    });
    const [, patchInit] = fetchMock.mock.calls[1];
    expect((patchInit as RequestInit).method).toBe('PATCH');
    expect((patchInit as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/merge-patch+json'
    });
    expect(JSON.parse(String((patchInit as RequestInit).body))).toEqual({
      spec: { resources: { requests: { storage: '1024Mi' } } }
    });

    // 2. 幂等 / 禁止缩容：当前已是 1Gi（1024Mi），再请求 1024Mi 或 512Mi 直接跳过 PATCH
    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-1', requestedStorage: '1Gi', capacityStorage: '1Gi' })
    );
    await expect(driver.resize(VOLUME_NAME, { storageSize: '512Mi' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: false,
      requestedBytes: 1024 * MIB,
      capacityBytes: 1024 * MIB
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 3. PATCH 2xx 响应体无法按 PVC 解析时不混入 PATCH 前的旧 capacityBytes
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({ uid: 'uid-1', requestedStorage: '512Mi', capacityStorage: '512Mi' })
      )
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: true,
      requestedBytes: 1024 * MIB
    });

    // 4. 缺 RBAC patch 权限（403）与 StorageClass 不支持扩容（422）保留状态码
    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1', requestedStorage: '512Mi' }))
      .mockResolvedValueOnce(errorResponse(403, 'forbidden patch'));
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).rejects.toMatchObject({
      status: 403
    });

    fetchMock
      .mockResolvedValueOnce(pvcResponse({ uid: 'uid-1', requestedStorage: '512Mi' }))
      .mockResolvedValueOnce(errorResponse(422, 'only dynamically provisioned pvc can be resized'));
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).rejects.toMatchObject({
      status: 422
    });

    // 4b. 支持 K8s DecimalExponent 科学计数法（如 1e9、5e8）
    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-1', requestedStorage: '1e9', capacityStorage: '1e9' })
    );
    await expect(driver.resize(VOLUME_NAME, { storageSize: '5e8' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: false,
      requestedBytes: 1_000_000_000,
      capacityBytes: 1_000_000_000
    });

    // 5. 非法容量格式 / 缺失 PVC / 删除中 PVC 拒绝扩容
    for (const invalidSize of ['invalid', '512K', '1Ei', '1e400']) {
      await expect(driver.resize(VOLUME_NAME, { storageSize: invalidSize })).rejects.toMatchObject({
        status: 400
      });
    }
    fetchMock.mockResolvedValueOnce(notFoundResponse());
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).rejects.toMatchObject({
      status: 404
    });
    fetchMock.mockResolvedValueOnce(
      pvcResponse({ uid: 'uid-1', deletionTimestamp: '2026-07-30T00:00:00Z' })
    );
    await expect(driver.resize(VOLUME_NAME, { storageSize: '1024Mi' })).rejects.toMatchObject({
      status: 409
    });
  });

  it('uses metadata.resourceVersion optimistic concurrency on resize PATCH and retries 409 conflicts monotonically', async () => {
    const { K8sVolumeDriver } = await import('../../src/drivers/K8sVolumeDriver');
    const driver = new K8sVolumeDriver();
    const MIB = 1024 * 1024;

    // 1. 携带 resourceVersion 的 PATCH 遭遇 409，重读发现更大目标（2048Mi）已胜出 -> 幂等返回 resized: false 且绝不降级
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({
          uid: 'uid-1',
          resourceVersion: '100',
          requestedStorage: '512Mi',
          capacityStorage: '512Mi'
        })
      )
      .mockResolvedValueOnce(errorResponse(409, 'the object has been modified'))
      .mockResolvedValueOnce(
        pvcResponse({
          uid: 'uid-1',
          resourceVersion: '101',
          requestedStorage: '2048Mi',
          capacityStorage: '512Mi'
        })
      );

    await expect(driver.resize(VOLUME_NAME, { storageSize: '1536Mi' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: false,
      requestedBytes: 2048 * MIB,
      capacityBytes: 512 * MIB
    });
    const [, firstPatchInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(String((firstPatchInit as RequestInit).body))).toEqual({
      metadata: { resourceVersion: '100' },
      spec: { resources: { requests: { storage: '1536Mi' } } }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 2. 遭遇 409，重读发现较小目标（1024Mi）胜出 -> 使用最新 resourceVersion 重试 PATCH 并成功扩至 2048Mi
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        pvcResponse({
          uid: 'uid-1',
          resourceVersion: '200',
          requestedStorage: '512Mi',
          capacityStorage: '512Mi'
        })
      )
      .mockResolvedValueOnce(errorResponse(409, 'the object has been modified'))
      .mockResolvedValueOnce(
        pvcResponse({
          uid: 'uid-1',
          resourceVersion: '201',
          requestedStorage: '1024Mi',
          capacityStorage: '512Mi'
        })
      )
      .mockResolvedValueOnce(
        pvcResponse({
          uid: 'uid-1',
          resourceVersion: '202',
          requestedStorage: '2048Mi',
          capacityStorage: '512Mi'
        })
      );

    await expect(driver.resize(VOLUME_NAME, { storageSize: '2048Mi' })).resolves.toEqual({
      claimName: VOLUME_NAME,
      resized: true,
      requestedBytes: 2048 * MIB,
      capacityBytes: 512 * MIB
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      metadata: { resourceVersion: '200' },
      spec: { resources: { requests: { storage: '2048Mi' } } }
    });
    expect(JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body))).toEqual({
      metadata: { resourceVersion: '201' },
      spec: { resources: { requests: { storage: '2048Mi' } } }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
