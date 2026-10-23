/**
 * 核心数据结构定义。
 * 每篇文章一个 DocData，序列化为单一 annotations 数组落盘，
 * 路径为 annotations/{域名}/{标题slug}-{key}.json。
 */

/** 一条批注。comment 为空字符串时表示"纯划线"（没有想法）。 */
export interface Annotation {
  /** UUID v4 */
  id: string;
  /** 选中的原文（用于匹配恢复） */
  quote: string;
  /** quote 之前 30 个字符的上下文（用于锚点定位） */
  prefix: string;
  /** quote 之后 30 个字符的上下文（用于锚点定位） */
  suffix: string;
  /**
   * quote 起点在页面全文中的字符偏移量。
   *
   * “页面全文”指正文文本按空白归一化后的结果（连续空白折叠为单个空格，
   * 不裁剪首尾，保证偏移与原文一一对应）。这是字符偏移，不是出现序号；
   * 仅用于多个候选都能匹配时挑距离最近的那个。
   */
  pos_hint: number;
  /** 批注正文。空字符串 = 纯划线。 */
  comment: string;
  /** ISO 8601 创建时间 */
  created_at: string;
  /** ISO 8601 最近更新时间 */
  updated_at: string;
  /** 软删除时间；null 表示未删除 */
  deleted_at: string | null;
}

/** 一篇文章的全部批注容器。 */
export interface DocData {
  /** 规范化后的原始 URL（便于识别） */
  url: string;
  /** 文章标题（抓取时的 document.title，方便浏览索引） */
  title: string;
  /** 文章作者或站点名（抓取时的 meta 信息；旧数据可能没有） */
  author?: string;
  /** 划线数量（comment 为空且未删除的批注数）；派生字段，写入时刷新 */
  highlight_count?: number;
  /** 想法数量（comment 非空且未删除的批注数）；派生字段，写入时刷新 */
  note_count?: number;
  /** 所有批注（包括软删除的）。消费方应自行过滤 deleted_at !== null。 */
  annotations: Annotation[];
}

/** 文档 key 元信息。 */
export interface DocKey {
  /** URL 规范化后 SHA-256 的前 16 位 */
  key: string;
  /** 规范化后的 URL（key 的来源） */
  normalizedUrl: string;
  /** key 前 2 位，用于文件路径 annotations/{prefix}/{key}.json */
  prefix: string;
}

/** 空的 DocData 工厂（方便新建）。 */
export function emptyDocData(url: string, title = "", author = ""): DocData {
  return {
    url,
    title,
    author,
    highlight_count: 0,
    note_count: 0,
    annotations: [],
  };
}

/** 过滤掉软删除批注。返回新数组。 */
export function activeAnnotations(doc: DocData): Annotation[] {
  return doc.annotations.filter((a) => a.deleted_at === null);
}

/** 计算划线/想法数量。 */
export function deriveCounts(doc: DocData): {
  highlight_count: number;
  note_count: number;
} {
  let highlights = 0;
  let notes = 0;
  for (const annotation of doc.annotations) {
    if (annotation.deleted_at !== null) continue;
    if (annotation.comment.trim()) notes++;
    else highlights++;
  }
  return { highlight_count: highlights, note_count: notes };
}

/** 重新计算并回填计数，返回新对象。 */
export function refreshDocCounts(doc: DocData): DocData {
  return { ...doc, ...deriveCounts(doc) };
}

/**
 * 序列化为磁盘文本：两空格缩进 + 末尾换行，方便在 GitHub 上直接翻阅。
 */
export function serializeDoc(doc: DocData): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 从磁盘文本解析回运行时结构。 */
export function parseDoc(text: string): DocData {
  return JSON.parse(text) as DocData;
}

/**
 * 按 id 合并两份批注列表（云端 vs 本地）。
 * 规则：同一个 id，取 updated_at 较新者。
 * 若一侧有、另一侧没有，保留。
 */
export function mergeAnnotations(
  local: Annotation[],
  remote: Annotation[]
): Annotation[] {
  const map = new Map<string, Annotation>();
  for (const a of local) map.set(a.id, a);
  for (const a of remote) {
    const prev = map.get(a.id);
    if (!prev || new Date(a.updated_at) >= new Date(prev.updated_at)) {
      map.set(a.id, a);
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  );
}
