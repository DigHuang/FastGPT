import type { ParentIdType } from '@fastgpt/global/common/parentFolder/type';
import type { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import type { ClientSession, Model } from '../../common/mongo';
import { resumeResourcePermissionInheritance } from './resourcePermissionService';

export type SyncChildrenPermissionResourceType = {
  _id: string;
  type: string;
  teamId: string;
  parentId?: ParentIdType;
  inheritPermission?: boolean;
};

/** 恢复资源继承并同步完整子树。 */
export async function resumeInheritPermission({
  resource,
  resourceModel,
  resourceType,
  session
}: {
  resource: SyncChildrenPermissionResourceType;
  resourceType: PerResourceTypeEnum;
  resourceModel: Model<any>;
  session?: ClientSession;
}) {
  return resumeResourcePermissionInheritance({
    resource,
    resourceModel,
    resourceType,
    session
  });
}
