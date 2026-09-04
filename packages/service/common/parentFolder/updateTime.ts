import type { ClientSession, Model } from '../mongo';
import { mongoSessionRun } from '../mongo/sessionRun';

type ParentFolderDocument = {
  _id: unknown;
  parentId?: unknown;
};

/**
 * 刷新一个或多个资源位置的全部祖先目录更新时间。
 *
 * 从多个 parentId 沿父链收集并去重祖先，再用一次 updateMany 写入相同时间。传入 session 时加入调用方事务；
 * 未传 session 时自行创建事务。查询始终带 teamId，避免损坏的跨团队 parentId 影响其他团队。
 */
export const updateParentFoldersUpdateTime = async ({
  parentIds,
  teamId,
  model,
  session
}: {
  parentIds: Array<string | null | undefined>;
  teamId: string;
  model: Model<any>;
  session?: ClientSession;
}): Promise<void> => {
  const initialParentIds = parentIds.filter((id): id is string => !!id).map(String);
  if (initialParentIds.length === 0) return;

  const update = async (activeSession: ClientSession) => {
    const pendingIds = [...initialParentIds];
    const ancestorIds: string[] = [];
    const visited = new Set<string>();
    while (pendingIds.length > 0) {
      const currentId = pendingIds.shift();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);
      const parent: ParentFolderDocument | null = await model
        .findOne({ _id: currentId, teamId }, 'parentId')
        .session(activeSession)
        .lean<ParentFolderDocument>();
      if (!parent) continue;

      ancestorIds.push(String(parent._id));
      if (parent.parentId) pendingIds.push(String(parent.parentId));
    }

    if (ancestorIds.length === 0) return;

    await model.updateMany(
      { _id: { $in: ancestorIds }, teamId },
      { $set: { updateTime: new Date() } },
      { session: activeSession }
    );
  };

  if (session) {
    await update(session);
    return;
  }
  await mongoSessionRun(update);
};
