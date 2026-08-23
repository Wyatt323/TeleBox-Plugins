# TeleBox-Plugins

个人维护的 [TeleBox](https://github.com/TeleBoxOrg/TeleBox) 自定义插件仓库。

## 插件清单

| 插件 | 命令 | 功能 |
| --- | --- | --- |
| `tj.ts` | `.tj` | 统计指定消息的所有回复，输出用户、时间和内容。 |
| `aix.ts` | `.aix` | 个人维护的 AI 功能插件。 |
| `stsave.ts` | `.stsave` / `.st` | 保存贴纸或将回复媒体转换并保存至贴纸包。 |
| `yvlux.ts` | `.yvlux` | 语录贴纸插件；为避免冲突，使用 `yvlux` 而非官方 `yvlu` 命令。 |

## tj：消息回复统计

支持两种使用方式：

```text
.tj https://t.me/c/1821626401/1686
```

或直接回复目标消息后发送：

```text
.tj
```

输出内容包括：

- 全部直接回复的数量；
- 每条回复的用户、北京时间和文本内容；
- 非文本回复标记为 `[非文本消息]`；
- 结果较长时自动拆成多条 Telegram 消息。

## 部署到 Skyline-SG

本仓库附带 Ansible playbook。它会：

1. 将 `plugins/` 下的插件复制到 `/root/telebox/plugins/`；
2. 验证每个插件可以由 `esbuild` 转换；
3. 重启 PM2 中的 `telebox`；
4. 检查 TeleBox 进程状态。

执行：

```bash
cd /root/Project/TeleBox-Plugins
/root/Project/Ansible/.venv/bin/ansible-playbook \
  -i /root/Project/Ansible/inventory/hosts.ini \
  ansible/deploy.yml
```

## 新增插件流程

1. 新建 `plugins/插件名.ts`，需默认导出一个 TeleBox `Plugin` 实例；
2. 在本地进行 TypeScript/esbuild 检查；
3. 提交并推送：

```bash
git add plugins/
git commit -m "feat: add 插件名 plugin"
git push
```

4. 使用上面的 Ansible 命令部署。

## 注意事项

- 此仓库只保存自定义插件源码，不保存 TeleBox 的 `config.json`、Telegram session、API 凭据或运行数据。
