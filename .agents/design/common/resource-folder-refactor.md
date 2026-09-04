# 资源目录链路重构

## 背景

App、Dataset 和 Agent Skill 都使用 `parentId` 组织目录。现有代码已经复用了目录深度校验，
但移动权限同步仍在三个 API 中重复实现，祖先目录更新时间也有两份同构代码；同时目标父级只做权限校验，
没有在公共层保证整条父链均为合法文件夹。

## 设计

1. `checkCreateFolderDepth` 除深度外校验整条父链类型；每个业务传入自己的合法文件夹判定。
2. `checkMoveFolderDepth` 分开接收“被移动资源是否为文件夹”和“合法目标文件夹”判定，
   防止普通资源被作为父级，同时保留 App Agent/Tool 两棵目录树的差异。
3. 移动 ACL 统一调用 `moveResourcePermissions`。API 只读取新父级 ACL，旧父级、资源自身和继承子树
   均由权限服务在同一事务内处理。
4. 删除仅服务于旧移动实现的 `syncCollaborators`、`syncChildrenPermission`，以及已经无效的
   `folderTypeList` 参数。
5. 祖先目录时间刷新下沉到 `service/common/parentFolder`。调用方在主事务成功后触发，刷新任务失败
   只记录日志，不反向影响已经成功的主业务。
6. 不统一 App、Dataset、Skill 的鉴权、字段更新、审计和业务副作用。

## TODO

- [x] 扩展并测试创建/移动的目标文件夹类型校验。
- [x] 三套移动 API 迁移到 `moveResourcePermissions`。
- [x] 删除旧权限兼容函数和死参数。
- [x] 统一 App/Skill 祖先目录时间刷新及事务边界。
- [x] 修复知识库训练重置 await、Skill 重复查询和 App 无效 reject。
- [x] 为普通 Dataset/Skill 创建入口补目标文件夹类型校验。
- [x] 运行目录、权限和相关 API 局部测试。
