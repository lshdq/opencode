# OpenCode 目录迁移到 D 盘说明

OpenCode V2 没有一个能将所有目录统一迁走的配置项。可以通过用户级环境变量迁移主要的数据、配置、缓存和状态目录；OpenCode Desktop 的独立用户数据目录需要另外处理。

## 当前环境与目标目录

以下路径是迁移前通过 `opencode debug paths` 在当前 Windows 环境中查到的：

| 内容 | 当前目录 | 建议的新目录 | 环境变量及其取值 |
| --- | --- | --- | --- |
| 会话数据库、日志、仓库等 | `C:\Users\lshdq\.local\share\opencode` | `D:\OpenCode\data\opencode` | `XDG_DATA_HOME=D:\OpenCode\data` |
| 配置 | `C:\Users\lshdq\.config\opencode` | `D:\OpenCode\config\opencode` | `XDG_CONFIG_HOME=D:\OpenCode\config` |
| 缓存及下载的可执行文件 | `C:\Users\lshdq\.cache\opencode` | `D:\OpenCode\cache\opencode` | `XDG_CACHE_HOME=D:\OpenCode\cache` |
| 服务状态 | `C:\Users\lshdq\.local\state\opencode` | `D:\OpenCode\state\opencode` | `XDG_STATE_HOME=D:\OpenCode\state` |

环境变量的值是目标 `opencode` 目录的**上一级**。当前临时目录已位于 `D:\temp\systemp\opencode`，无需再迁移。当前未设置 `OPENCODE_DB`，因此数据库会随数据目录一起迁移，不必单独设置该变量；如果以后显式设置了 `OPENCODE_DB`，需要另外核对其指向的数据库位置。

## 安全迁移顺序

1. 关闭所有 OpenCode 客户端，并运行 `opencode service stop` 停止后台服务；确认没有仍在使用旧数据库的 OpenCode 进程。
2. 备份上述四个旧目录，再将其**完整复制**到表中对应的新目录。不要在服务运行期间复制数据库。
3. 在 Windows 用户级环境变量中设置表中的四个 `XDG_*_HOME` 变量。不要仅设置变量而不复制原数据，否则 OpenCode 会像全新安装一样启动。
4. 重新登录 Windows，或确保新启动的 OpenCode 和后台服务均继承了新的环境变量。
5. 运行 `opencode debug paths`，确认 `data`、`cache`、`config`、`state`、`db` 等指向 D 盘；再打开 OpenCode，确认旧会话和配置可用。确认迁移成功前，不要删除 C 盘原目录。

## Desktop 与其他目录

如果使用 OpenCode Desktop，它还会在 Electron 的用户数据目录保存独立状态；正式版通常位于 `%APPDATA%\ai.opencode.desktop`，不受上述四个 XDG 变量控制。若也要迁出 C 盘，应在退出 Desktop 后单独备份、迁移，并考虑使用指向 D 盘的目录联接。不要为迁移 OpenCode 而直接改动全系统的 `%APPDATA%` 或用户主目录。

这些变量也不能保证搬走 Bun、系统或其他工具的缓存。因此这里的“全部”是指 OpenCode 的主要 XDG 目录；Desktop 用户数据及外部工具产生的文件需要分别核对。

参考：[V2 CLI 路径说明](https://opencode.ai/v2/docs/cli#paths)、[V2 数据库和服务文件位置](https://opencode.ai/v2/docs/troubleshooting#service-files)。
