# FocusLens 项目交接综述

更新时间：2026-06-15  
项目源码根目录：`D:\adhd\adhd-warning`

## 1. 项目现状

FocusLens 是一个本地优先的学习辅助系统，当前主要包含：

- 学习专注监控、日历、错题记录、AI 教师等既有功能。
- Markdown-first Wiki V2：
  - 薄弱诊断图谱
  - 知识库阅读器
  - 待确认箱
  - AI 整理规划、审核、执行和撤销
  - 学习材料生成
- OpenAI-compatible 第三方模型接入。

当前主开发对象已经不是旧版单页 `index.html`，而是：

- 后端：`focuslens-api/`，FastAPI + Pydantic + SQLAlchemy。
- 前端：`focuslens-v2/`，React 19 + TypeScript + Vite。
- Wiki 数据：运行目录中的 `focuslens-api/wiki/`，以 Markdown 和 JSON 文件为主要存储。

根目录已有的 `DEVELOPMENT.md` 主要描述早期纯前端版本，部分内容已经过时。开发 Wiki V2 或当前主应用时，不应以该文档的“完全断网、单 HTML 文件”为架构依据。

## 2. 最重要的开发方式

本机目前存在“源码仓库”和“实际运行目录”两套文件：

| 用途 | 后端 | 前端 |
| --- | --- | --- |
| Git 源码，所有正式修改应写入这里 | `D:\adhd\adhd-warning\focuslens-api` | `D:\adhd\adhd-warning\focuslens-v2` |
| 当前实际运行目录 | `D:\adhd\focuslens-api` | `D:\adhd\focuslens-v2` |

开发原则：

1. 首先修改并测试 `D:\adhd\adhd-warning` 中的源码。
2. 测试通过后，将改动文件同步到对应运行目录。
3. 后端 Python 文件同步后需要重启 8012 服务。
4. 前端 Vite 通常能热更新，但同步后仍需刷新浏览器验证。
5. Wiki 真实运行数据位于 `D:\adhd\focuslens-api\wiki`，不要用源码目录中的测试数据覆盖它。

不要只修改运行目录，否则改动不会进入 Git 仓库；也不要只修改源码后就声称运行页面已修复。

## 3. 启动与验证

### 源码仓库启动

在 `D:\adhd\adhd-warning` 执行：

```powershell
.\start.bat
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8012`
- 健康检查：`http://127.0.0.1:8012/api/health`

当前日常运行通常使用独立运行目录中的 `_run.bat`：

```powershell
D:\adhd\focuslens-api\_run.bat
D:\adhd\focuslens-v2\_run.bat
```

### 必跑验证

后端：

```powershell
cd D:\adhd\adhd-warning\focuslens-api
python -m unittest discover -v
```

前端：

```powershell
cd D:\adhd\adhd-warning\focuslens-v2
npm test -- --run
npm run build
```

最近验证结果：

- 后端：69 项测试通过。
- 前端：17 项测试通过。
- 前端生产构建通过。
- 构建仍提示单个 JS chunk 约 669 KB，属于待优化问题。

所有显著 UI 改动还应在真实运行页面中检查，特别是 Wiki 目录、知识页正文、AI 整理状态和执行后的自动刷新。

## 4. Wiki V2 架构

### 后端关键文件

- `wiki_models.py`：Pydantic 模型、允许的 AI 操作类型。
- `wiki_markdown.py`：结构化 Markdown 解析和渲染。
- `wiki_store.py`：原子写入、事务、快照、回滚。
- `wiki_ingest.py`：从学习事件摄取知识。
- `wiki_graph.py`：薄弱知识图谱生成。
- `wiki_agent.py`：AI 整理扫描、规划、验证、执行和撤销。
- `wiki_migration.py`：旧版知识页向结构化 Wiki V2 迁移及修复。
- `wiki_artifacts.py`：练习卷、闪卡、阶段报告等材料生成。
- `wiki_routes.py`：`/api/wiki` V2 路由。
- `event_store.py`：学习事件存储。

### 前端关键文件

- `src/wiki/WikiWorkspace.tsx`：Wiki V2 总容器和数据刷新。
- `src/wiki/WeakDiagnosisView.tsx`：薄弱诊断图谱。
- `src/wiki/KnowledgeBrowserView.tsx`：知识库目录和正文阅读。
- `src/wiki/InboxView.tsx`：待确认项审核。
- `src/wiki/OrganizerView.tsx`：AI 整理规划、选择、执行、撤销。
- `src/wiki/MaterialsView.tsx`：学习材料生成。
- `src/wiki/api.ts`、`types.ts`：API 封装和类型。

### Wiki 运行数据

主要位于 `D:\adhd\focuslens-api\wiki`：

- `knowledge/`：结构化知识页和仍保留的旧版平铺知识页。
- `organize_runs/`：AI 整理运行记录。
- `changelog/`：事务操作日志。
- `snapshots/`：事务执行前快照，供撤销使用。
- `trash/`：事务删除或合并后的页面。
- `.organize_index.json`：增量整理索引。

读取中文 JSON/Markdown 时，PowerShell 必须显式使用 UTF-8：

```powershell
Get-Content -Raw -Encoding utf8 <path>
```

否则终端可能显示乱码，但文件本身不一定损坏。

## 5. AI 整理机制

AI 整理不是直接让模型写文件，而是：

1. 扫描 Wiki 状态。
2. 调用模型提出结构化操作。
3. 后端校验操作 schema、目标页面、锁定字段和冲突。
4. 前端展示最终方案供用户选择。
5. 用户点击执行后，后端通过事务写入。
6. 可使用快照撤销。

允许的操作包括：

- `create_page`
- `update_fields`
- `merge_pages`
- `move_page`
- `add_links`
- `remove_links`
- `archive_evidence`
- `trash_page`

每批最多生成 8 项操作，目的是保持方案可审核、可撤销。因此一次执行后仍有“待整理”页面是正常的，需要再次生成下一批。

`plan.rounds` 表示 AI 为得到合法方案所尝试的次数，不代表 UI 中三个业务步骤。前端现已改为：

- 规划成功后，步骤 1 到 3 均显示完成。
- 步骤 4 单独表示“等待执行 / 正在写入 / 已写入 / 已撤销”。
- 执行或撤销后，`WikiWorkspace` 自动刷新页面、图谱和待确认箱。

## 6. 最近完成的关键修复

### 知识正文为空

根因：旧版正文迁移到了渲染器不支持的章节名，重新渲染时正文被丢弃，只留下“核心概念”等空标题。

已修复：

- `wiki_migration.py` 将旧内容映射到标准章节。
- 可修复现有空壳知识页。
- 修复时只填充空章节，不覆盖已有内容。
- 使用 `create_missing=False` 时不会复活已被合并删除的页面。
- 运行数据已修复 14 个现有知识页，未重建 6 个已合并页面。
- 阅读器会隐藏无内容的章节标题。

### “待整理”没有变化

最新真实执行记录：

- Run ID：`run_4c0e805d`
- 状态：`executed`
- Transaction ID：`20260615_223839_81f0e628`
- 实际执行 8 项：
  - 数学 5 页移动到“数与代数”
  - 英语 2 页移动到“语法”
  - 英语 1 页移动到“写作”

当时看起来没有变化的原因是前端执行后没有刷新 Wiki 数据，现已修复。

当前运行页面仍存在的“待整理”：

- 英语：2 页
- 语文：1 页

这些需要用户审核下一批 AI 规划后再执行，不能在没有确认的情况下自动归类。

## 7. 第三方模型接入注意事项

- 接口采用 OpenAI-compatible `/v1` 风格。
- 配置由前端传入或保存在浏览器本地配置中。
- API Key 属于敏感信息，绝不能写入仓库、测试、日志或交接文档。
- 已针对 Qwen 风格模型做兼容：
  - 使用 JSON response mode。
  - 明确要求不要复述输入证据。
  - 中文风险等级归一化为 `low`、`medium`、`high`。
  - 合并操作会移除 source 列表中的 target 页面。
  - 仍有“待整理”页面时，优先生成章节归类操作。

真实模型测试可能产生费用。除非用户明确要求，不要自动反复调用模型，也不要自动执行 AI 规划。

## 8. 开发注意事项

1. 当前工作树非常脏，大量 Wiki V2 文件尚未提交。不要执行 `git reset --hard`、`git checkout --` 或覆盖用户改动。
2. `focuslens-api/main.py` 和 `focuslens-v2/src/main.tsx` 都已很大。新增 Wiki 功能应优先放到现有 Wiki 模块，不要继续膨胀主文件。
3. 知识页的 `manual_fields` 和 `locked_fields` 必须受到保护，AI 操作不能覆盖。
4. 所有 Wiki 写入应通过 `WikiStore` / `WikiTransaction`，保持原子写入、日志、快照和撤销能力。
5. 执行 AI 规划前会检查 source hash，避免在过期计划上写入。
6. 合并页面时必须确保 target 不在 source 列表中。
7. 不要直接删除 Wiki 页面；使用事务 trash 和可撤销机制。
8. 旧版平铺知识文件仍存在，它们是迁移和修复来源。清理前必须制定迁移完成判定和备份方案。
9. 前端 UI 状态必须与后端真实状态一致。成功提示不能代替数据刷新和页面验证。
10. 修改运行数据前应确认有事务快照或额外备份。

## 9. 待解决问题

优先级较高：

1. 继续通过可审核批次归类剩余 3 个“待整理”页面。
2. 为 Organizer 增加历史 Run 列表和恢复查看能力。目前页面刷新后，当前规划 UI 状态不会恢复，虽然后端 JSON 记录仍在。
3. 后端提供更明确的执行结果摘要，例如实际修改页面数、移动目标、跳过原因；前端执行成功后直接展示摘要。
4. 区分“规划流程状态”和“AI 尝试次数”的后端正式字段。目前步骤 1 到 3 是根据规划成功推导，而不是后端流式上报。
5. 制定旧版平铺 Wiki 文件最终退役方案，避免 V1/V2 双来源长期并存。

技术债：

1. 拆分过大的 `main.py` 和 `main.tsx`。
2. 解决后端 `datetime.utcnow()` 弃用警告。
3. 排查测试中的 SQLite 未关闭连接 `ResourceWarning`。
4. 对前端大 chunk 做按功能懒加载。
5. 增加端到端测试：生成规划、执行、目录自动刷新、撤销、刷新后恢复历史 Run。
6. 为真实运行目录同步建立可靠脚本，减少手工 `Copy-Item` 遗漏。
7. 整理并提交当前大量未提交改动，提交前应先审计敏感信息和运行数据。

## 10. 推荐接手顺序

1. 阅读本文件。
2. 执行 `git status --short`，确认并保护现有改动。
3. 跑后端、前端测试和构建，建立当前基线。
4. 启动服务并打开 Wiki 页面核对真实运行状态。
5. 检查 `D:\adhd\focuslens-api\wiki\organize_runs` 中最新 Run，而不是仅凭 UI 推断。
6. 开发时只改源码仓库，测试后同步到运行目录。
7. 每次涉及 Wiki 写入，都检查 changelog、snapshot 和浏览器实际页面。

## 11. 当前验收基线

接手后至少应保持以下行为：

- 知识页显示真实正文，空章节标题不展示。
- AI 整理规划可使用真实 OpenAI-compatible 模型生成结构化方案。
- 用户可以取消选择某些操作，只执行选中项。
- 执行成功后 Wiki 目录和图谱自动刷新。
- AI 整理步骤 1 到 3 在规划成功后显示完成。
- 步骤 4 清晰显示写入状态。
- 执行可以通过事务快照撤销。
- 未经用户确认，不自动执行 AI 整理计划。

