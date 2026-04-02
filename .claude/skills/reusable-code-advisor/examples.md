# 示例

以下示例说明工具名与回复格式；实际调用以当前环境提供的 `search_symbols` / `get_symbol_detail` 为准。

---

## 示例 1：用户要找「已有 HTTP 客户端封装」

**用户：** 我们项目里有没有封装好的 HTTP 请求方法？我想复用。

**助手动作：**

1. `search_symbols`，查询如 `http`、`fetch`、`request`、`axios` 等关键词。
2. 若前几条结果描述模糊，对排名前 2～3 个调用 `get_symbol_detail`。
3. 对比：是否统一错误处理、是否带超时/重试、是否强依赖全局配置等。

**示例回复：**

- **首选：** `createHttpClient`（示例名）
- **理由：**
    - 与「发请求 + 统一错误」需求一致，入参清晰。
    - 无额外全局单例，测试与复用成本低。
- **其他候选：** `legacyFetch` — 功能够用但缺少超时；`apiWrapper` — 强绑定业务路径，耦合高。
- **用法提示：** 在业务模块中 `import { createHttpClient } from '...'`，传入 `baseURL` 与可选 `defaultHeaders` 即可。

---

## 示例 2：用户要在多个「日期格式化」函数里选一个

**用户：** 格式化 ISO 日期成 `YYYY-MM-DD`，用哪个工具函数最好？

**助手动作：**

1. `search_symbols`，关键词如 `formatDate`、`dateFormat`、`toYYYYMMDD`。
2. 对返回类型/时区行为不确定的代码块调用 `get_symbol_detail`。
3. 对比：是否处理时区、是否纯函数、是否与团队现有日期库一致。

**示例回复：**

- **首选：** `formatDateToYMD`（示例名）
- **理由：**
    - 明确按本地日历日输出，与「展示用日期」需求一致。
    - 纯函数、无副作用，便于单测。
- **其他候选：** `formatISO` — 保留时间部分，需再截断；`momentFormat` — 依赖重，新代码不建议引入。
- **用法提示：** `formatDateToYMD(isoString)`，入参为 ISO 8601 字符串。

---

## 示例 3：没有合适代码块时

**用户：** 有没有现成的「把 PDF 转图片」工具函数？

**助手动作：**

1. `search_symbols`，关键词如 `pdf`、`render`、`toImage`。
2. 若结果均为无关或仅有文档/脚本级能力，可再换词检索一次；仍无则停止并如实说明。

**示例回复：**

- **首选：** 无完全匹配的可复用代码块。
- **理由：** 仓库内未发现封装好的 PDF 渲染管线；仅有通用文件 IO 或无关工具。
- **其他候选：** `readFileBuffer` — 只能读字节，不负责渲染；`spawnConverter` — 依赖外部二进制，环境不可控。
- **用法提示：** 若必须做该能力，建议新建独立模块并明确依赖（如指定 PDF 库），或走已有文档中约定的批处理流程（若有）。

---

## 真实 Case 1：按 props 结构找弹窗组件

**用户：** 我需要一个带 `content` 和 `onClose` 的弹窗组件，项目里有现成的吗？

**助手动作：**

1. `search_symbols`：`{ "query": "dialog", "type": "component", "limit": 20 }`
2. `search_by_structure`：`{ "fields": ["content", "onClose"], "type": "component", "ranked": true }`
3. 对 Top 3 调 `get_symbol_detail` 深挖签名与用法。

**示例回复：**

- **首选：** `Dialog`
- **理由：**
    - `props` 包含 `content`、`onClose`，与需求结构直接匹配。
    - 组件职责清晰，关闭行为由外部传入回调，复用风险低。
- **其他候选：** `ModalBase` — 能承载内容但缺少明确关闭回调约束。
- **用法提示：** 传入 `title/content/onClose` 三个关键参数，先在简单页面接入验证关闭交互。

---

## 真实 Case 2：按组件名和排序推荐导航栏组件

**用户：** 需要一个首页顶部栏，先看看项目里现成组件。

**助手动作：**

1. `search_symbols`：`{ "query": "homebar", "type": "component", "ranked": true, "limit": 20 }`
2. 对 Top 3 调 `get_symbol_detail`，确认是否含页面级副作用与业务耦合。

**示例回复：**

- **首选：** `HomeBar`
- **理由：**
    - 名称与场景高度匹配，文本匹配得分高。
    - 结构轻量，适合作为首页导航栏的复用起点。
- **其他候选：** `Header` — 更通用，但需要额外样式与交互改造。
- **用法提示：** 先直接替换首页顶部区域，再按业务增加按钮与事件。

---

## 真实 Case 3：先筛选再解释（组件推荐场景）

**用户：** 推荐一个表单输入组件，最好有 `onChange`。

**助手动作：**

1. 判定为“组件推荐”意图，优先走 `recommend_component`。
2. 请求参数：`{ "query": "form", "props": ["onChange"], "limit": 3 }`
3. 若返回候选较多，再对首选调用 `get_symbol_detail` 给集成建议。

**示例回复：**

- **首选：** `FormInput`
- **理由：**
    - `onChange` 结构命中，且排序分数最高。
    - 详情里有明确输入/变更模式，适合直接接入表单场景。
- **其他候选：** `SearchInput` — 可复用但交互偏搜索，不是通用表单输入。
- **用法提示：** 先接入受控状态（`value + onChange`），再补校验提示与错误态展示。
