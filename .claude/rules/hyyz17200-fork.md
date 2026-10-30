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
| `frontend/src/i18n/locales/*` | 上游频繁改动 | 定制文案不写进去，暂用 `t('hyyz17200.xxx', '默认文案')` |
| `CHANGELOG.md` | 上游几乎每次提交都改 | 不改 |
| `backend/app/core/database.py` | 约 8000 行，手写迁移 | 不加逻辑 |
| `backend/app/main.py` | 约 12500 行 | 只放挂载代码 |

## 扩展挂载点（`[infra]` 提交，尚未实现）

第一个功能补丁需要时才加。在 `main.py` 只改三处：

```python
from backend.app.hyyz17200 import register, run_migrations    # 文件顶部，同时导入模型
register(app)                                                 # 最后一个 include_router 之后
await run_migrations()                                        # lifespan 里 await init_db() 之后
```

- `init_db()` 先 `create_all` 再 `run_migrations`。模型在启动前导入，新表就会自动创建；补列放在自己的 `run_migrations` 里，并保证可重复执行。
- `load_all_models()` 只扫描 `backend/app/models/`，自己的测试要显式导入模型。
- SQLite 下外键约束是关闭的，删除不会级联，关联上游表的数据要自己清理孤儿记录。

## 部署

用户手动构建安装，**不用**应用内更新。`Dockerfile` 会从 `frontend/` 重新构建前端，不依赖仓库里的 `static/`。

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

新增或删除补丁时更新此表。

### 为什么要锁一键更新

Git 安装方式下，它会把 `origin` 改回上游，再 `git reset --hard` 到上游发布标签，补丁会从运行代码中消失。**rebase 后必须确认 `backend/tests/integration/test_hyyz17200_update_lock.py` 通过**，上游改动更新流程时它负责发现锁失效。

`test_updates_api.py` 的 autouse fixture 会在测试里关掉锁，因为上游那些测试覆盖的是锁后面的流程。

### SpoolBuddy 远程更新：有意不处理

用户不用 SpoolBuddy。这个更新只在有人手动触发时运行，只改设备上的代码，不影响主程序。如果以后要用：它会让设备执行 `git fetch origin <主程序当前分支>`，需要把设备的 `origin` 指向 fork，并推送 `hyyz17200` 分支。

## 文档本身

`.claude/` 被上游 `.gitignore` 忽略，本文件是用 `git add -f` 提交到 `hyyz17200` 的，所以切到 `dev` 时工作区里不会有它。后续修改正常提交即可。
