/**
 * JSX 检测、路径/selector 启发式、JSDoc 摘要、相对路径。
 */

import { Node, SyntaxKind } from "ts-morph";

/**
 * 判断源文件路径是否为 TSX（React JSX 语法所在扩展名）。
 * @returns `true` 表示按「可能出现 JSX」处理，用于与 `.ts` 区分组件启发式。
 */
export function isTsxFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".tsx");
}

/**
 * 在 AST 子树中是否出现 JSX 节点（元素、自闭合标签或 Fragment）。
 * @returns `true` 表示该导出更像 React 组件（与 `isTsxFile` 等组合用于分类）。
 */
export function hasJsxInNode(node: Node): boolean {
  let found = false;
  node.forEachDescendant((n) => {
    const k = n.getKind();
    if (
      k === SyntaxKind.JsxElement ||
      k === SyntaxKind.JsxSelfClosingElement ||
      k === SyntaxKind.JsxFragment
    ) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * 从文件路径推断业务语义目录名（如 `.../components/form/Button.tsx` → `form`）。
 * @returns 命中 `components|features|...` 下一级目录名；无法推断时为 `null`，写入 DB 的 `category` 字段。
 */
export function inferCategoryFromPath(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  const parts = norm.split("/");
  const markers = ["components", "features", "modules", "pages", "widgets", "hooks"];
  for (let i = 0; i < parts.length; i++) {
    const m = markers.indexOf(parts[i]);
    if (m >= 0 && parts[i + 1]) {
      return parts[i + 1];
    }
  }
  return null;
}

/**
 * 启发式判断导出是否更像状态选择器（selector）。
 * @returns `true` 时索引类型记为 `selector`，否则同文件下函数多为 `util`。
 */
export function isSelectorLike(filePath: string, exportName: string): boolean {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes("selector")) return true;
  if (/selector$/i.test(exportName)) return true;
  return false;
}

type MaybeJsDoc = { getJsDocs?: () => Array<{ getDescription(): string }> };

/**
 * 读取节点（或父节点）上第一段 JSDoc 的 **描述正文**（不含 `@tag`）。
 * @returns 供写入 `symbols.description`；无注释时为 `null`。
 */
export function getLeadingDocDescription(node: Node): string | null {
  const tryNode = (n: Node): string | null => {
    const jd = (n as unknown as MaybeJsDoc).getJsDocs;
    if (typeof jd !== "function") return null;
    const docs = jd.call(n);
    if (!docs?.length) return null;
    const t = docs[0].getDescription().trim();
    return t || null;
  };

  return tryNode(node) ?? (node.getParent() ? tryNode(node.getParent()!) : null);
}

/**
 * 将绝对路径转为相对 `projectRoot` 的路径，作为库中 `symbols.path`（便于跨机器、展示）。
 * @returns 相对路径；若无法裁掉前缀则回退为原始绝对路径。
 */
export function getRelativePathForDisplay(projectRoot: string, absolutePath: string): string {
  const r = projectRoot.replace(/\\/g, "/");
  const a = absolutePath.replace(/\\/g, "/");
  if (a.startsWith(r)) {
    return a.slice(r.length + 1);
  }
  return absolutePath;
}

/**
 * 截取节点对应源码文本，用于 `symbols.content`（全文检索或人工核对）。
 * @param maxLen 超长时截断并追加注释标记，避免单行 MEDIUMTEXT 过大。
 * @returns 源码字符串；无额外语义，仅作存档片段。
 */
export function snippetForNode(node: Node, maxLen = 4000): string | null {
  const raw = node.getText();
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen) + "\n/* ... truncated ... */";
}
