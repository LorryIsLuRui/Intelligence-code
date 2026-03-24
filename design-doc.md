🧠 一、项目背景 & 问题定义


1.1 背景

在中大型前端/Node 项目中，代码资产包括：

	• Component（组件）
	• Util（工具函数）
	• Selector（状态选择器）
	• TypeScript Types（类型定义）

但存在问题：
1️⃣ 代码分散（common / biz / legacy）
2️⃣ 命名不统一（FormV2 / AdvancedForm / SearchForm）
3️⃣ 文档缺失或过期
4️⃣ 依赖人工记忆（问人）



1.2 问题本质

❗不是“有没有代码”，而是：

👉 如何快速找到“合适且可复用”的代码



1.3 目标

构建一个：

👉 Code Intelligence MCP 系统

具备能力：
✔ 统一索引 component / util / selector / types
✔ 支持结构化搜索 + 语义搜索（可选）
✔ 支持推荐（ranking）
✔ 可被 Agent 调用（MCP 协议）



🎯 二、系统目标（明确边界）


2.1 功能目标
能力	描述
搜索	按名称 / 关键词
结构检索	按 props / 类型
推荐	返回最优代码
解释	为什么推荐
依赖分析	查使用关系



2.2 非目标（评审必写）
❌ 不做代码生成
❌ 不做自动重构
❌ 不做 CI/CD 改造



🧱 三、整体架构设计
                ┌────────────────────┐
                │       Agent        │
                │  (Skill Layer)     │
                └─────────┬──────────┘
                          │ MCP
                ┌─────────▼──────────┐
                │    MCP Server      │  ← Node
                │   (Tool Layer)     │
                └─────────┬──────────┘
     ┌────────────────────┼────────────────────┐
     │                    │                    │
┌────▼────┐         ┌─────▼─────┐        ┌────▼────┐
│ Indexer │         │ Search    │        │ Ranking │
│ (AST)   │         │ Engine    │        │ Engine  │
└────┬────┘         └─────┬─────┘        └────┬────┘
     │                    │                   │
     └───────────────┬────▼────┬─────────────┘
                     │ MySQL   │
                     └─────────┘
（可选增强）
           Python Embedding Service



🧩 四、核心模块设计



4.1 Code Indexer（代码索引器）


目标

将代码 → 结构化数据（symbols）



支持类型
component / util / selector / type



技术方案（Node）

	• ts-morph（核心）
	• fast-glob（扫描）



抽象结构（统一模型）
{
  "name": "FormInput",
  "type": "component",
  "path": "src/components/FormInput.tsx",
  "description": "支持校验",
  "meta": {
    "props": ["value", "onChange"],
    "hooks": ["useForm"],
    "returnType": "JSX.Element"
  }
}

通用 symbol 设计（推荐你升级）
{
  "name": "...",
  "type": "...",
  "category": "...",
  "path": "...",
  "meta": {},
  "relations": []
}


👉 关键点：


✅ type = 技术类型
component / util / style / api / type



✅ category = 业务语义
form / table / layout / auth


👉 这样你可以做：

👉 跨类型搜索



关键解析能力
类型	提取信息
component	props / hooks
util	参数 / 返回值
selector	state 依赖
type	字段结构




4.2 MySQL 数据模型


symbols 表（核心）
CREATE TABLE symbols (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255),
  type ENUM('component','util','selector','type'),
  category TEXT
  path TEXT,
  description TEXT,
  content MEDIUMTEXT,
  meta JSON,
  usage_count INT DEFAULT 0,
  created_at TIMESTAMP
);



dependencies 表（可选）
CREATE TABLE dependencies (
  from_id INT,
  to_id INT
);




4.3 Search Engine



能力 1：关键词搜索
WHERE name LIKE '%xxx%'



能力 2：结构搜索
JSON_CONTAINS(meta->'$.props', '"onChange"')



能力 3（可选）：语义搜索

Node → Python → embedding




4.4 Ranking Engine（核心亮点）



评分函数
score =
  文本匹配分 * 0.5
+ usage_count * 0.3
+ recency * 0.1
+ common目录加权 * 0.1



输出
{
  "name": "FormPro",
  "score": 0.92,
  "reason": "匹配度高 + 使用频率高"
}



🔧 五、MCP / Tool 设计（核心）



5.1 MCP Server（Node）



Tool 1️⃣ search_symbols
{
  "query": "form",
  "type": "component"
}



Tool 2️⃣ get_symbol_detail
{
  "name": "FormInput"
}



Tool 3️⃣ search_by_structure
{
  "props": ["onChange"]
}



Tool 4️⃣ list_dependencies
{
  "name": "FormInput"
}



Tool 5️⃣ get_usage_stats
{
  "name": "FormInput"
}


👉 特点：

	• 全部无状态
	• 原子能力
	• 可复用



🤖 六、Skill 设计（Agent 层）



Skill 1️⃣ recommend_component（核心）



流程
1️⃣ search_symbols
2️⃣ 结构过滤
3️⃣ ranking
4️⃣ get_detail
5️⃣ 输出 reason




Skill 2️⃣ find_reusable_code


输入：需求描述
输出：可复用代码列表




Skill 3️⃣ explain_symbol


输入：symbol
输出：用途 + 使用方式




Skill 4️⃣ detect_duplicate


查找重复实现（高级）




🔗 七、Tool & Skill 串联关系（重点）



示例：推荐组件
用户输入：
👉 “带校验的表单组件”
Agent（Skill）：
1️⃣ 调 search_symbols
2️⃣ 调 search_by_structure
3️⃣ 调 get_usage_stats
4️⃣ 排序
5️⃣ 调 get_symbol_detail
6️⃣ 输出结果


👉 数据流：
User → Agent(Skill) → MCP(Tools) → DB → MCP → Agent → User



🚀 八、开发步骤（0 → 1）



Phase 1（基础）

	• MCP Server（Node）
	• search_symbols
	• get_detail



Phase 2（索引）

	• ts-morph AST
	• MySQL 建表

👉 工程落地：见仓库 `README.md`「Phase 2：代码索引」；执行 `npm run index`（需 `MYSQL_ENABLED=true`）。

👉 **何时建索引、是否用变更文件做增量**：见下文 **9.7 索引触发与增量更新**。



Phase 3（增强）

	• structure search
	• ranking



Phase 4（Agent）

	• Skill 实现



Phase 5（可选）

	• Python embedding



📈 九、可扩展优化方案（评审加分点）



9.1 语义搜索

	• 引入 embedding
	• FAISS / pgvector



9.2 使用频率采集

	• Git commit 分析
	• import 次数统计



9.3 实时索引

	• Git hook / watcher
	• 与 **9.7** 配合：日常可对「变更文件列表」做局部更新，控制成本；大范围改动再全量重扫



9.4 去重检测（高级）

	• AST similarity
	• embedding similarity



9.5 推荐优化
加入：
- 团队偏好
- 组件健康度



9.6 前端 UI（加分）

	• 类似组件市场
	• 可视化搜索



9.7 索引触发与增量更新（生产建议）

**面临的问题**

	• 代码**何时**写入索引库？若**只在发布流水线成功之后**才索引，智能检索会与日常开发主干脱节，合码后长时间搜不到新组件。
	• 若**每次 Push 都全量扫描**，算力与 DB 压力大，且短时间多次提交会造成抖动。

**推荐策略（约 2 日一发、中等规模团队可参考）**

	• **主触发**：代码**合入主干**（如 `main`）后触发索引（可对短时间多次 push 做 **debounce**，合并为一次任务），使检索贴近当前主干。
	• **辅触发**：**发布流水线成功**后再跑一遍索引（或与发布 tag / 产物 SHA 对齐），形成与**线上一致**的「发布快照」，便于对齐版本与排障。

**基于变更文件列表的局部更新**

	• CI 或 Git hook 产出**相对上次已成功索引的 commit** 的变更路径列表（如 `git diff --name-only <lastIndexedSha> HEAD`）。
	• 索引任务**仅解析、upsert 列表中的文件**；若文件已删除，则在 DB 中**删除对应符号或标记失效**。
	• 当变更面过大（大批量重命名、依赖升级、目录迁移等）时，**退化为全量重扫**，避免局部更新漏扫导致数据不一致。
	• 与全量入口（如 MCP `reindex`、CLI 全仓库扫描）**并存**：常态增量、里程碑或修复后全量校验。



🎯 十、风险 & 解决方案



风险 1：AST 解析复杂

👉 解决：

	• 降级为字符串解析（初期）



风险 2：数据不准

👉 解决：

	• 增加人工标签



风险 3：性能

👉 解决：

	• 索引缓存
	• 分批扫描



🧠 十一、总结（评审用）


本系统基于 MCP 构建代码智能检索能力
通过 AST 将代码结构化，并结合检索与排序，实现组件与工具的智能推荐
在架构上遵循 Tool 与 Skill 分层，具备良好的扩展性与演进能力



💬 最后一句（我给你的建议）

这套方案如果你做到：

	• Node MCP + AST + MySQL ✅
	• 
		○ 一个 recommend skill ✅

👉 已经是：

中高级工程项目（可以写在简历最前面）


如果你下一步要继续，我可以帮你直接给：

👉 完整 Node 项目骨架代码（可运行）
👉 或 ts-morph AST 解析完整实现

你现在这一步，已经不是“学习项目”，而是可以往面试杀手项目走了。
