# 评测指标与失败阶段映射

## 三个失败阶段

推荐主链：`语义搜索 → 可复用过滤 → 结构过滤 → 排序 → 质量门控 → 返回`

---

## 阶段 1：向量召回未命中（`no_semantic_recall`）

symbol 根本没被向量搜索捞到，后续所有步骤都不存在。

| 指标            | 值                                     |
| --------------- | -------------------------------------- |
| Recall@10       | **0**                                  |
| Recall@50       | **0**（换更大 K 也没用，根本没进候选） |
| 首位命中分(MRR) | **0**                                  |
| Top-1           | **False**                              |

**优化方向**：调大 `SYMBOL_TOP_K` / 增加 `queryVariants` / 增强中文同义词扩展

---

## 阶段 2：候选被误过滤（`reusability_filtered` / `structure_filtered`）

symbol 被向量捞到了，但在进入排序前被过滤掉（路径含 test/demo、或 category 不匹配）。

| 指标            | 值                                        |
| --------------- | ----------------------------------------- |
| Recall@10       | **0**                                     |
| Recall@50       | **0**（过滤发生在排序之前，K 再大也没用） |
| 首位命中分(MRR) | **0**                                     |
| Top-1           | **False**                                 |

> **关键**：Stage 1 和 Stage 2 的四个指标值**完全一样**，无法从指标区分——必须看 `Failure Breakdown` 表格（evalTrace 归因）。

**优化方向**：

- `reusability_filtered` → 检查 `isReusableCandidate` 路径规则是否误杀
- `structure_filtered` → 检查 category 过滤条件

---

## 阶段 3：排名未进前列

### 3a. `ranked_below_topk`（进了候选池，排在第 11–50 位）

| 指标            | 值                                           |
| --------------- | -------------------------------------------- |
| Recall@10       | **0**（没进 Top-10）                         |
| Recall@50       | **> 0** ← **唯一能从指标区分阶段 3a 的信号** |
| 首位命中分(MRR) | **0**                                        |
| Top-1           | **False**                                    |

**优化方向**：调整 `RANK_WEIGHTS` / `LITERAL_MATCH_PRIORITY_BOOST`

### 3b. `quality_gate_rejected`（进了候选池但质量分不够，被门控拦截）

| 指标            | 值                                        |
| --------------- | ----------------------------------------- |
| Recall@10       | **0**                                     |
| Recall@50       | **0**（质量门控在返回前拦截，K 大也没用） |
| 首位命中分(MRR) | **0**                                     |
| Top-1           | **False**                                 |

**优化方向**：按 symbol type 降低质量门控阈值（函数/Hook 可比组件更宽松）

---

## 汇总：四个指标实际只能区分两种状态

```
所有指标=0, recall50=0  →  无法区分阶段1/2/3b，必须看 Failure Breakdown 表格
所有指标=0, recall50>0  →  确定是 ranked_below_topk（唯一可从指标推断的阶段）
Recall>0, MRR<1, Top-1=✗  →  找到了但排名靠后，靠 MRR 定位排名问题
Recall=1, MRR=1, Top-1=✓  →  完美
```

## 诊断流程

1. 看 `召回率(Recall@10)` → 是否被捞到
2. 对比 `Recall@50` vs `Recall@10` → 差距大说明排名问题（阶段 3a）
3. 看 `首位命中分(MRR)` → 找到了但排在哪里
4. 看 `首条准确率(Top-1)` → 主答案有没有排第一
5. 看 **Failure Breakdown 表格** → 精确定位阶段 1 / 2 / 3b 的比例

> 四个汇总指标是快速健康检查，精确归因靠 evalTrace 的 Failure Breakdown。
