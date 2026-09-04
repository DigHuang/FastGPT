import { describe, expect, it, vi } from 'vitest';
import type { ClientSession, Model } from '@fastgpt/service/common/mongo';
import { updateParentFoldersUpdateTime } from '@fastgpt/service/common/parentFolder/updateTime';

const { mongoSessionRunMock } = vi.hoisted(() => ({
  mongoSessionRunMock: vi.fn()
}));

vi.mock('@fastgpt/service/common/mongo/sessionRun', () => ({
  mongoSessionRun: mongoSessionRunMock
}));

describe('updateParentFoldersUpdateTime', () => {
  it('skips root resources without opening a transaction', async () => {
    await updateParentFoldersUpdateTime({
      parentIds: [null],
      teamId: 'team-1',
      model: {} as Model<any>
    });

    expect(mongoSessionRunMock).not.toHaveBeenCalled();
  });

  it('collects the ancestor chain and updates it once in the provided transaction', async () => {
    const docs = new Map([
      ['child-folder', { _id: 'child-folder', parentId: 'root-folder' }],
      ['sibling-folder', { _id: 'sibling-folder', parentId: 'root-folder' }],
      ['root-folder', { _id: 'root-folder', parentId: null }]
    ]);
    const session = {} as ClientSession;
    const findOne = vi.fn((query: { _id: string; teamId: string }) => ({
      session: (activeSession: ClientSession) => ({
        lean: async () => {
          expect(activeSession).toBe(session);
          return docs.get(query._id) ?? null;
        }
      })
    }));
    const updateMany = vi.fn().mockResolvedValue(undefined);
    const model = { findOne, updateMany } as unknown as Model<any>;

    await updateParentFoldersUpdateTime({
      parentIds: ['child-folder', 'sibling-folder'],
      teamId: 'team-1',
      model,
      session
    });

    expect(findOne.mock.calls.map(([query]) => query)).toEqual([
      { _id: 'child-folder', teamId: 'team-1' },
      { _id: 'sibling-folder', teamId: 'team-1' },
      { _id: 'root-folder', teamId: 'team-1' }
    ]);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      _id: { $in: ['child-folder', 'sibling-folder', 'root-folder'] },
      teamId: 'team-1'
    });
    expect(updateMany.mock.calls[0]?.[1]).toEqual({
      $set: { updateTime: expect.any(Date) }
    });
    expect(updateMany.mock.calls[0]?.[2]).toEqual({ session });
  });

  it('stops safely when the ancestor chain contains a cycle', async () => {
    const docs = new Map([
      ['folder-a', { _id: 'folder-a', parentId: 'folder-b' }],
      ['folder-b', { _id: 'folder-b', parentId: 'folder-a' }]
    ]);
    const model = {
      findOne: (query: { _id: string }) => ({
        session: () => ({ lean: async () => docs.get(query._id) ?? null })
      }),
      updateMany: vi.fn().mockResolvedValue(undefined)
    } as unknown as Model<any>;

    await updateParentFoldersUpdateTime({
      parentIds: ['folder-a'],
      teamId: 'team-1',
      model,
      session: {} as ClientSession
    });

    expect(model.updateMany).toHaveBeenCalledOnce();
  });

  it('opens a transaction and continues other roots after a missing parent', async () => {
    const session = {} as ClientSession;
    mongoSessionRunMock.mockImplementationOnce(
      async (handler: (activeSession: ClientSession) => Promise<void>) => handler(session)
    );
    const updateMany = vi.fn();
    const model = {
      findOne: (query: { _id: string }) => ({
        session: (activeSession: ClientSession) => ({
          lean: async () => {
            expect(activeSession).toBe(session);
            return query._id === 'existing-folder'
              ? { _id: 'existing-folder', parentId: null }
              : null;
          }
        })
      }),
      updateMany
    } as unknown as Model<any>;

    await updateParentFoldersUpdateTime({
      parentIds: ['missing-folder', 'existing-folder'],
      teamId: 'team-1',
      model
    });

    expect(mongoSessionRunMock).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      _id: { $in: ['existing-folder'] },
      teamId: 'team-1'
    });
  });
});
