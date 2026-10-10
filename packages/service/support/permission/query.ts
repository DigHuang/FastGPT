import type { PerResourceTypeEnum } from '@fastgpt/global/support/permission/constant';
import { getGroupsByTmbId } from './memberGroup/controllers';
import { getOrgsByTmbId } from './org/controllers';
import { resourcePermissionRepo } from './repository/resourcePermissionRepo';

/**
 * 批量关联成员、用户组、直属组织与资源 ACL，返回已配置资源及命中的授权行。
 * 这里只读取权限基础数据；默认开放、所有权和个人授权优先级由资源自身的鉴权规则决定。
 */
export const getMemberResourcePermissionData = async ({
  teamId,
  tmbId,
  resourceType
}: {
  teamId: string;
  tmbId: string;
  resourceType: PerResourceTypeEnum;
}) => {
  const [groups, orgs, permissions] = await Promise.all([
    getGroupsByTmbId({ teamId, tmbId }),
    getOrgsByTmbId({ teamId, tmbId }),
    resourcePermissionRepo.findByTeam({ teamId, resourceType })
  ]);
  const groupIds = new Set(groups.map((group) => String(group._id)));
  const orgIds = new Set(orgs.map((org) => String(org.orgId)));

  return {
    configuredResourceIds: new Set(
      permissions.flatMap((permission) =>
        permission.resourceId ? [String(permission.resourceId)] : []
      )
    ),
    permissions: permissions.filter(
      (permission) =>
        (permission.tmbId && String(permission.tmbId) === tmbId) ||
        (permission.groupId && groupIds.has(String(permission.groupId))) ||
        (permission.orgId && orgIds.has(String(permission.orgId)))
    )
  };
};
