# hyyz17200 私有 fork 补丁架构

本仓库是 `maziggy/bambuddy` 的私有 fork。部分改动上游不一定接受，但基础代码必须持续跟上上游。修改代码前先读完本文。

## 分支

| 分支 | 用途 | 规则 |
|---|---|---|
| `upstream/dev` | 上游开发分支 | 只读 |
| `dev` | 上游的纯净镜像 | **只允许 fast-forward，绝不提交** |
| `hyyz17200` | `dev` + 补丁，构建和部署用这条 | 所有定制都提交到这里 |

- 只有一条补丁分支。`[fix]`、`[infra]`、`[feat]`、`[docs]` 是**提交信息的前缀**，不是分支。
- 补丁始终排在上游提交之后，用 rebase 跟进上游，**不要 merge 上游**。
- 补丁保持原子：一个功能对应一个或少数几个提交。后续修正用 `git commit --fixup` 并入原提交，不要堆 “fix” 提交。

## 同步上游

```bash
git config rerere.enabled true          # 只需设置一次
git fetch upstream
git switch dev && git merge --ff-only upstream/dev && git push origin dev
git tag hyyz17200-backup-$(date +%Y%m%d) hyyz17200
git switch hyyz17200 && git rebase dev
# 跑测试，并用 git range-diff 确认补丁没有走样
git push --force-with-lease origin hyyz17200
```

- 上游接受了某个补丁时，内容相同 rebase 会自动跳过；内容不同就手动删掉自己的版本。
- `--force-with-lease` 只用于 `hyyz17200`，绝不用于 `dev`。

## 代码放在哪

用 `hyyz17200` 命名，避免和上游将来的名字撞车。

- 后端：`backend/app/hyyz17200/`（自己的 router、service、模型）。
- 前端：`frontend/src/hyyz17200/`。
- 数据库：同一个库，表名前缀 `hyyz17200_`。关联上游的表用外键，不给上游的表加列。
- 改上游文件时，优先用包装或事件订阅；必须改时改动要尽量少，单独成提交，并用 `hyyz17200` 标记（常量、注释或 i18n key），方便 grep。

## 不要动的文件

| 位置 | 原因 | 做法 |
|---|---|---|
| `static/` | 上游提交的构建产物，文件名带 hash | **补丁绝不提交**。本地 `npm run build` 后用 `git restore static && git clean -fd static` 还原 |
| `frontend/src/i18n/locales/*` | 上游频繁改动 | 定制文案写进 `frontend/src/hyyz17200/locales.ts` |
| `CHANGELOG.md` | 上游几乎每次提交都改 | 不改 |
| `backend/app/core/database.py` | 约 8000 行，手写迁移 | 只放挂载代码 |
| `backend/app/main.py` | 约 12500 行 | 只放挂载代码 |

## 扩展挂载点（`[infra]` 提交，已实现）

上游文件里只留这些连接点，新功能**不需要再改它们**（新增页面、导航、文案、表、接口都只动 `hyyz17200` 目录）：

| 上游文件 | 连接点 | 新功能放在哪 |
|---|---|---|
| `backend/app/main.py` | `register_hyyz17200(app)` | 接口：`backend/app/hyyz17200/api.py`（全部在 `/api/v1/hyyz17200/` 下） |
| `backend/app/core/database.py` 的 `init_db()` | 导入模型包、调用迁移 | 表：`backend/app/hyyz17200/models/`，模块要在其 `__init__.py` 里导入；补列：`backend/app/hyyz17200/migrations.py` |
| `frontend/src/App.tsx` | `{hyyz17200Routes}` | 页面：`frontend/src/hyyz17200/routes.tsx` |
| `frontend/src/components/Layout.tsx` | `...hyyz17200NavItems` | 侧边栏：`frontend/src/hyyz17200/nav.ts` |
| `frontend/src/i18n/index.ts` | `withHyyz17200Locale` | 文案：`frontend/src/hyyz17200/locales.ts`，用 `t('hyyz17200.xxx')` |

- 迁移挂在 `init_db()` 内部而不是 `main.py` 的启动流程，因为备份恢复和 `cli.py` 也直接调用 `init_db()`。
- `init_db()` 先 `create_all` 再跑迁移。新表自动创建；补列语句要能重复执行，用 `core.database._safe_execute`。
- `load_all_models()` 只扫描 `backend/app/models/`，自己的测试要显式导入模型。
- SQLite 下外键约束是关闭的，删除不会级联，关联上游表的数据要自己清理孤儿记录。
- 新接口必须带鉴权依赖（`RequirePermissionIfAuthEnabled`），否则 `test_route_auth_coverage.py` 会失败。
- 新接口用 `Depends(get_db, scope="function")`，否则 `test_get_db_function_scope.py` 会失败。
- `SettingsPage.test.tsx` 写死了上游的侧边栏顺序，所以在该文件里 mock 掉了 `hyyz17200/nav`，新增导航项不用改它。
- `backend/tests/integration/test_hyyz17200_mounts.py` 和 `frontend/src/__tests__/hyyz17200/mounts.test.ts` 负责发现 rebase 后断开的挂载点。

## 部署

用户手动构建安装，**不用**应用内更新。`Dockerfile` 会从 `frontend/` 重新构建前端，不依赖仓库里的 `static/`。

本地和 `Dockerfile` 的 Node 版本不同时以 Docker 构建结果为准（镜像用 Node 22）。`lazyPage.test.tsx` 的 sessionStorage 用例在 Node 26 下失败、Node 22 下通过，与补丁无关。

## 在 Windows 上验证后端

这台 Windows 机器上全量测试本来就有约 200 项失败或错误，所以判断补丁有没有问题时，要在**同一个盘**上和 `dev` 对比失败清单（测试路径校验与盘符有关，跨盘对比会多出一批假差异）。

### `test_bambu_ftp.py` 的失败

只要改动不涉及 FTP，且 `bambu_ftp.py`、`test_bambu_ftp.py`、`mock_ftp_server.py` 与 `dev` 无差异，这个文件的失败和差异**一律忽略，不算补丁回归**。

原因是一条连锁故障，不是随机波动：

1. 上传结束时 `bambu_ftp.py` 直接调用 `conn.close()`，没有完成 TLS 关闭握手。
2. 模拟 FTP 服务器卡在 TLS 关闭阶段，文件句柄不释放，测试清理目录时报 `WinError 32`。
3. 残留连接逐渐触及模拟服务器的单 IP 连接数限制，后面的用例连不上，还没执行到要验证的逻辑就失败了（如 `client._ftp` 为 `None` 导致的 `AttributeError`）。

残留程度不同，失败名单就不同，所以两个分支的名单不一致也不能当作回归证据。

如果改动涉及 FTP，不能忽略，要这样验证：只在测试进程内让上传的数据连接先完成 TLS 关闭握手再关闭，再跑 `test_bambu_ftp.py::TestUpload`（对照结果：原代码 8 失败、9 通过、16 个清理错误；握手后 17 个全部通过）。

这个握手**只用于测试验证，不要提交到生产代码**：`bambu_ftp.py` 直接和真实打印机通信，改关闭流程必须先用真机验证。

## 当前补丁

| 提交 | 内容 | 上游文件改动 |
|---|---|---|
| `[fix] Lock the in-app updater on this fork` | `POST /updates/apply` 拒绝更新，设置页不显示安装按钮；检查更新保留 | `updates.py`、`SettingsPage.tsx`、`test_updates_api.py` |
| `[docs] Fork patch architecture rule` | 本文件 | 无 |
| `[infra] Fork mount points` | 上表的挂载点和 `hyyz17200` 目录骨架，含 `GET /api/v1/hyyz17200/info` | 上表 5 个文件、`SettingsPage.tsx` |
| `[feat] Hide chosen fault codes` | 上游 #3269。设置页维护隐藏码，被隐藏的故障不计入角标、不发提醒 | `main.py`、`notify_live_activities.py`、`App.tsx`、`HMSErrorModal.tsx`、`SettingsPage.test.tsx` |
| `[feat] Cam wall frame cache` | 后端缓存每台打印机最后一帧好画面，请求立刻返回，后台按需抓帧 | 无 |
| `[feat] Cam wall keeps the last frame` | 摄像头墙失败时保留上一帧，不再黑屏；实时路数可设为 0 | `CameraTile.tsx`、`CameraWall.tsx`、`CamWallPage.tsx`、`PrintersPage.tsx`、`CameraTile.test.tsx` |

新增或删除补丁时更新此表。

### 摄像头墙保留上一帧

上游的快照单元每次刷新都重建 `<img>`，加载期间和失败后都是黑屏，连续失败两次后还会停在“无信号”。现在单元用 `fetch` 取帧，解码成功才替换画面。

- 接口：`GET /api/v1/hyyz17200/printers/{id}/camera/snapshot-cached?interval=秒`。路径必须包含 `/camera/snapshot`：鉴权中间件和 `sw.js` 都按这个子串放行，真正的校验在路由的 token 依赖里。
- 后端（`camera_frames.py`）：抓帧走上游的 `camera_snapshot()`，所以有实时流时复用它的帧，不开第二个连接。同一台打印机一次一个抓帧，全局最多 2 个并发，连续失败时间隔翻倍（上限 120 秒），1 小时没人读就丢弃缓存。只有墙用这个缓存：完成照片、热床检测要现拍的帧，不能走这里。
- 前端（`useWallFrame.ts`）：一次只发一个请求，失败不影响画面，页面隐藏时停止轮询。只有 401 才刷新 token。最后一帧放在实时流下层，旧帧超过“两个刷新间隔 + 20 秒”时显示年龄角标。
- 实时单元：流出现首帧后（或等 15 秒后）才开始取帧，避免和正在建立的流抢打印机唯一的连接。流失败后退回快照，至少 1 分钟后且抓到新帧才重开。流失败仍是 DOM 上的 `<img>` 出错，启用鉴权时会触发全页重新签发 token，这一点没有改。
- rebase 时如果上游改了 `CameraTile.tsx` 的快照逻辑，优先保留这里的取帧方式；`camera_snapshot` 的签名变了，`test_hyyz17200_camera_frames.py` 会失败。
- 上游如果解决了黑屏，删掉这两个补丁，改用上游的方案。

### 隐藏故障码

只在“提醒”这一层隐藏，`PrinterState.hms_errors`、API、WebSocket、调度和失败原因始终能看到全部故障。上游文件各只有一处连接点：

| 上游文件 | 作用 |
|---|---|
| `main.py` 状态回调，`_take_new_hms_faults` 之后 | 过滤推送通知和 MQTT relay 告警（`main.py` “只放挂载代码”的特批例外：这里之后的代码拿不到 `full_code`）。必须放在去重之后，否则取消隐藏时仍在的故障会重新告警 |
| `notify_live_activities.py` 的 `_printer_fault` | Live Activity 不显示被隐藏的故障 |
| `HMSErrorModal.tsx` 的 `counts()` | 角标、红点、摄像头墙、批量工具栏都走这里；故障仍折叠显示在弹窗中，“清除错误”按钮保留 |
| `App.tsx` 的 `<HiddenFaultsSync />` | 加载隐藏列表。挂在 `App` 而不是 `Layout`，因为 `/camwall` 不在 `Layout` 内 |

- 匹配规则在 `hms_filter.py` 和 `hiddenFaults.ts` 各有一份，改动时要同步。
- 默认不隐藏任何码。BMCU 预设不含 `print_error`，`0500_4004` 这类真实的打印错误只能手动添加。
- 不支持免登录的 kiosk 摄像头墙（`?token=`）：启用鉴权时它拿不到列表，仍显示全部故障。
- 上游如果实现了 #3269，删掉这个补丁，改用上游的方案。

### 为什么要锁一键更新

Git 安装方式下，它会把 `origin` 改回上游，再 `git reset --hard` 到上游发布标签，补丁会从运行代码中消失。**rebase 后必须确认 `backend/tests/integration/test_hyyz17200_update_lock.py` 通过**，上游改动更新流程时它负责发现锁失效。

`test_updates_api.py` 的 autouse fixture 会在测试里关掉锁，因为上游那些测试覆盖的是锁后面的流程。

### SpoolBuddy 远程更新：有意不处理

用户不用 SpoolBuddy。这个更新只在有人手动触发时运行，只改设备上的代码，不影响主程序。如果以后要用：它会让设备执行 `git fetch origin <主程序当前分支>`，需要把设备的 `origin` 指向 fork，并推送 `hyyz17200` 分支。

## 文档本身

`.claude/` 被上游 `.gitignore` 忽略，本文件是用 `git add -f` 提交到 `hyyz17200` 的，所以切到 `dev` 时工作区里不会有它。后续修改正常提交即可。
