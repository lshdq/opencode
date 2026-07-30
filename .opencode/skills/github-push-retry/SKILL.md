---
name: github-push-retry
description: 向 GitHub 推送 git 分支/标签，网络失败自动隔 10 秒重试直到成功。Use ONLY when pushing git refs to github.com from this workspace and the network is flaky/intermittent (github 时断时续). 触发关键词：推送 github、push 重试、推不上去、网络失败重试、git push retry、连不上 github。Do NOT use for non-github remotes or non-push git operations.
---

# github-push-retry

github.com 时断时续（TCP 443 间歇被墙）。本 skill 把 `git push` 包成**失败即隔 10 秒自动重试、直到成功**的单次调用，避免手工反复推。

## 强制规则

1. 用**单次 bash 工具调用**执行脚本，禁止自行编写 `while`/`sleep` 重试循环：

   ```
   pwsh.exe -NoProfile -ExecutionPolicy Bypass -File <base>/scripts/push-retry.ps1 -RepoDir <仓库路径> -Args "<git push 的参数>"
   ```

   `<base>` = 本 skill 目录。工作区内即 `D:\works\thirdparty\opencode\.opencode\skills\github-push-retry`。

2. bash 工具的 `timeout`（毫秒）按需设大，如 `1800000`（30 分钟）。**无限重试下若网络长期不通，会一直跑到 timeout 被杀**——timeout 即实际尝试窗口。

3. 脚本退出码：
   - `0` = 推送成功
   - `2` = 非网络失败（认证 / 被拒 / 非快进等），**不重试**，需人工处理
   - `3` = 达到 `-MaxAttempts` 上限（仅当 `-MaxAttempts > 0`）

4. 脚本只对**网络错误**重试（连接超时 / 拒绝 / 重置 / HTTP 5xx / unable to access / RPC failed / early EOF 等）；非网络错误立即退出。

## 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `-RepoDir` | 否 | 当前目录 | git 仓库路径 |
| `-Args` | 是 | — | `git push` 的参数字符串，如 `"-u origin win-adapt"`、`"origin dev"` |
| `-RetryDelaySec` | 否 | 10 | 每次重试间隔秒数 |
| `-MaxAttempts` | 否 | 0 | 最大尝试次数；`0` = 无限重试直到成功 |

## 示例

推送 `win-adapt` 分支到 fork（无限重试，bash `timeout=1800000`）：

```
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File D:\works\thirdparty\opencode\.opencode\skills\github-push-retry\scripts\push-retry.ps1 -RepoDir D:\works\thirdparty\opencode -Args "-u origin win-adapt"
```

推送多个分支可分多次调用，或 `-Args "origin dev win-adapt"`。
