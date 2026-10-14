import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({
  downloadSkillPackageStream: vi.fn(),
  ensureTarGzSkillPackage: vi.fn()
}));

vi.mock('@fastgpt/service/core/ai/skill/package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fastgpt/service/core/ai/skill/package')>()),
  downloadSkillPackageStream: mocks.downloadSkillPackageStream,
  ensureTarGzSkillPackage: mocks.ensureTarGzSkillPackage
}));

import { deploySkillPackage } from '@fastgpt/service/core/ai/sandbox/application/runtime/skill/prepare';

const successResult = {
  exitCode: 0,
  stdout: '',
  stderr: ''
};

describe('skill package streaming prepare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureTarGzSkillPackage.mockImplementation(
      async ({ storageKey }: { storageKey: string }) => storageKey
    );
  });

  it('streams the S3 .tar.gz package into sandbox FIFO and extracts without intermediate archive files', async () => {
    const source = Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]);
    mocks.downloadSkillPackageStream.mockResolvedValue(source);
    const uploadedChunks: Buffer[] = [];
    const fifoPaths: string[] = [];
    const sandbox = {
      createDirectories: vi.fn().mockResolvedValue(undefined),
      deleteFiles: vi.fn(async (paths: string[]) =>
        paths.map((path) => ({ path, success: true, error: null }))
      ),
      getFileInfo: vi.fn(async () => new Map()),
      execute: vi.fn().mockResolvedValue(successResult),
      writeFiles: vi.fn(async ([entry]: Array<{ path: string; data: Buffer | string }>) => {
        if (entry.path === '/workspace/.gitignore') {
          return [{ path: entry.path, bytesWritten: String(entry.data).length, error: null }];
        }
        if (entry.path.endsWith('/input.eof')) {
          return [{ path: entry.path, bytesWritten: 0, error: null }];
        }

        expect(entry.path).toMatch(/^\/tmp\/\.fastgpt-restore-.*\/stream\.pipe$/);
        fifoPaths.push(entry.path);
        const buf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
        uploadedChunks.push(buf);

        return [{ path: entry.path, bytesWritten: buf.length, error: null }];
      })
    };
    const baseContext = {
      sandbox: sandbox as any,
      workDirectory: '/workspace'
    };

    await deploySkillPackage({
      storageKey: 'version.tar.gz',
      skillsRootPath: '/workspace/skills'
    })(baseContext);

    expect(mocks.ensureTarGzSkillPackage).toHaveBeenCalledWith({ storageKey: 'version.tar.gz' });
    expect(mocks.downloadSkillPackageStream).toHaveBeenCalledWith({ storageKey: 'version.tar.gz' });
    expect(Buffer.concat(uploadedChunks).toString()).toBe('chunk-1chunk-2');
    expect(fifoPaths.length).toBeGreaterThan(0);
    expect(source.destroyed).toBe(true);
    expect(sandbox.createDirectories).toHaveBeenCalledWith(['/workspace/skills']);
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.stringContaining('mkfifo'),
      expect.objectContaining({ timeoutMs: 600_000 })
    );
    expect(sandbox.execute).toHaveBeenCalledWith(
      expect.stringContaining('tar -xf - -C "$1" --no-same-owner --no-same-permissions'),
      expect.objectContaining({ timeoutMs: 600_000 })
    );
    expect(sandbox.getFileInfo).toHaveBeenCalledWith(['/workspace/.gitignore']);
    expect(sandbox.writeFiles).toHaveBeenLastCalledWith([
      {
        path: '/workspace/.gitignore',
        data: expect.stringContaining('node_modules')
      }
    ]);
  });

  it('destroys an unconsumed S3 stream when sandbox FIFO write fails', async () => {
    const source = Readable.from([Buffer.from('content')]);
    mocks.downloadSkillPackageStream.mockResolvedValue(source);
    const sandbox = {
      createDirectories: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue(successResult),
      writeFiles: vi.fn().mockResolvedValue([
        {
          path: '/tmp/.fastgpt-restore-1/stream.pipe',
          bytesWritten: 0,
          error: new Error('upload failed')
        }
      ])
    };
    await expect(
      deploySkillPackage({ storageKey: 'version.tar.gz', skillsRootPath: '/workspace/skills' })({
        sandbox: sandbox as any,
        workDirectory: '/workspace'
      })
    ).rejects.toThrow('Failed to write archive stream to sandbox: upload failed');
    expect(source.destroyed).toBe(true);
  });
});
