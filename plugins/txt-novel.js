module.exports = {
  name: "TXT Novel Reader",
  match: { ext: ".txt" },
  fileLoadMode: "full",
  theme: {
    overlayBg: "rgba(2, 6, 23, 0.62)",
    surfaceBg: "#f8fafc",
    surfaceBgElevated: "#ffffff",
    text: "#0f172a",
    textMuted: "#475569",
    border: "rgba(15, 23, 42, 0.12)",
    primary: "#2563eb",
    primaryText: "#ffffff",
    radius: "10px",
    shadow: "0 16px 40px rgba(2, 6, 23, 0.22)",
    focusRing: "rgba(37, 99, 235, 0.4)",
    danger: "#dc2626",
    warning: "#d97706",
    success: "#16a34a",
  },

  viewContext(file) {
    const content = normalizeContent(file.content);
    const query = file.query || {};
    const chapterPattern = createChapterPattern();
    const chapters = extractChapters(content, chapterPattern, file.name);
    const total = chapters.length;
    const chapterIdx = clamp(
      safeInt(query.chapter, 1) - 1,
      0,
      Math.max(0, total - 1),
    );
    const current = chapters[chapterIdx];

    return [
      `文件：${file.path || file.name || ""}`,
      `当前章节：${current.title}`,
      `章节进度：${chapterIdx + 1} / ${total}`,
    ].join("\n");
  },

  process(file) {
    const content = normalizeContent(file.content);
    const query = file.query || {};

    const chapterPattern = createChapterPattern();
    const chapters = extractChapters(content, chapterPattern, file.name);
    const total = chapters.length;

    const chapterIdx = clamp(safeInt(query.chapter, 1) - 1, 0, Math.max(0, total - 1));
    const current = chapters[chapterIdx];
    const paragraphs = extractParagraphs(content, current, chapterPattern);

    const tocValue = String(query.toc || "0");
    const showToc = tocValue !== "0";
    const nextTocValue = String(safeInt(tocValue, 0) + 1);

    const tocPageSize = 8;
    const tocPageCount = Math.max(1, Math.ceil(total / tocPageSize));
    const tocPageDefault = Math.floor(chapterIdx / tocPageSize) + 1;
    const tocPage = clamp(safeInt(query.tocPage, tocPageDefault), 1, tocPageCount);

    const mergeQuery = (patch) => ({ ...query, ...patch });
    const elements = createReaderElements(current.title, chapterIdx, total, mergeQuery);
    addNavButtons(elements, "t", chapterIdx, total, nextTocValue, mergeQuery);
    addNavButtons(elements, "b", chapterIdx, total, nextTocValue, mergeQuery);
    appendParagraphElements(elements, paragraphs, 500);

    addButton(
      elements,
      "toc-prev",
      "前页",
      { tocPage: tocPage - 1 },
      tocPage <= 1,
      mergeQuery,
      "secondary",
    );
    addButton(
      elements,
      "toc-next",
      "后页",
      { tocPage: tocPage + 1 },
      tocPage >= tocPageCount,
      mergeQuery,
      "secondary",
    );

    appendTocElements(elements, chapters, chapterIdx, tocPage, tocPageSize, mergeQuery);

    return {
      data: { ui: { tocOpen: showToc } },
      tree: { root: "root", elements },
    };
  },
};

function createChapterPattern() {
  return /^(?:\s*)(第[\d一二三四五六七八九十百千万零〇两]+[章节回卷篇部][^\n]*|(?:正文\s*)?第\s*[\d一二三四五六七八九十百千万零〇两]+\s*[章节回卷篇部][^\n]*|Chapter\s+\d+[^\n]*|CHAPTER\s+\d+[^\n]*|\d+\s*[.、]\s*[^\n]{1,120})$/i;
}

function normalizeContent(value) {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function extractChapters(content, chapterPattern, fileName) {
  const starts = [];
  const globalPattern = new RegExp(chapterPattern.source, "gim");
  let match;
  while ((match = globalPattern.exec(content)) !== null) {
    starts.push({
      start: match.index,
      title: (match[1] || "").trim(),
    });
  }

  if (starts.length === 0) {
    return [
      {
        title: fileName ? String(fileName).replace(/\.txt$/i, "") : "正文",
        start: 0,
        end: content.length,
      },
    ];
  }

  const chapters = [];
  for (let i = 0; i < starts.length; i++) {
    chapters.push({
      title: starts[i].title,
      start: starts[i].start,
      end: i + 1 < starts.length ? starts[i + 1].start : content.length,
    });
  }
  return chapters;
}

function extractParagraphs(content, chapter, chapterPattern) {
  const rawSection = content.slice(chapter.start, chapter.end).trim();
  const sectionLines = rawSection.split("\n");

  let firstContentLine = 0;
  while (firstContentLine < sectionLines.length) {
    const line = sectionLines[firstContentLine].trim();
    if (!line) {
      firstContentLine++;
      continue;
    }
    if (chapterPattern.test(line)) {
      firstContentLine++;
      continue;
    }
    break;
  }

  return sectionLines
    .slice(firstContentLine)
    .map((line) => line.trim())
    .filter(Boolean);
}

function createReaderElements(currentTitle, chapterIdx, total, mergeQuery) {
  return {
    root: {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: ["header", "nav-top", "content-card", "nav-bottom", "toc-dialog"],
    },

    header: {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", justify: "between", align: "center" },
      children: ["title", "progress"],
    },
    title: {
      type: "Heading",
      props: { text: currentTitle, level: "h4" },
      children: [],
    },
    progress: {
      type: "Text",
      props: { text: `进度 ${chapterIdx + 1} / ${total}`, variant: "muted" },
      children: [],
    },

    "nav-top": {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", justify: "between" },
      children: ["prev-t", "toc-t", "next-t"],
    },

    "content-card": {
      type: "Card",
      props: {
        title: null,
        description: null,
        maxWidth: "full",
      },
      children: ["para-stack"],
    },
    "para-stack": {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: [],
    },

    "nav-bottom": {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", justify: "between" },
      children: ["prev-b", "toc-b", "next-b"],
    },
    "toc-dialog": {
      type: "Dialog",
      props: {
        title: "章节目录",
        description: null,
        openPath: "/ui/tocOpen",
      },
      children: ["toc-nav", "toc-list", "toc-close"],
    },
    "toc-nav": {
      type: "Stack",
      props: { direction: "horizontal", gap: "sm", justify: "between", align: "center" },
      children: ["toc-prev", "toc-next"],
    },
    "toc-list": {
      type: "Stack",
      props: { direction: "vertical", gap: "sm" },
      children: [],
    },
    "toc-close": {
      type: "Button",
      props: { label: "关闭", variant: "secondary" },
      on: { press: { action: "navigate", params: { query: mergeQuery({ toc: "0" }) } } },
      children: [],
    },
  };
}

function addButton(elements, id, label, queryPatch, disabled, mergeQuery, variant = "secondary") {
  elements[id] = {
    type: "Button",
    props: { label, variant, disabled },
    on: { press: { action: "navigate", params: { query: mergeQuery(queryPatch) } } },
    children: [],
  };
}

function addNavButtons(elements, suffix, chapterIdx, total, nextTocValue, mergeQuery) {
  addButton(
    elements,
    `prev-${suffix}`,
    "上一章",
    { chapter: chapterIdx, toc: "0" },
    chapterIdx <= 0,
    mergeQuery,
  );
  elements[`toc-${suffix}`] = {
    type: "Button",
    props: { label: "目录", variant: "secondary", disabled: false },
    on: { press: { action: "navigate", params: { query: mergeQuery({ toc: nextTocValue }) } } },
    children: [],
  };
  addButton(
    elements,
    `next-${suffix}`,
    "下一章",
    { chapter: chapterIdx + 2, toc: "0" },
    chapterIdx >= total - 1,
    mergeQuery,
  );
}

function appendParagraphElements(elements, paragraphs, maxParagraphs) {
  const paraChildren = elements["para-stack"].children;
  const shownParagraphs = paragraphs.slice(0, maxParagraphs);

  shownParagraphs.forEach((paragraph, index) => {
    const id = `p-${index}`;
    elements[id] = { type: "Text", props: { text: paragraph, variant: "body" }, children: [] };
    paraChildren.push(id);
  });

  if (paragraphs.length > maxParagraphs) {
    const moreId = "p-more";
    elements[moreId] = {
      type: "Text",
      props: { text: `（本章较长，仅展示前 ${maxParagraphs} 段）`, variant: "muted" },
      children: [],
    };
    paraChildren.push(moreId);
  }
}

function appendTocElements(elements, chapters, chapterIdx, tocPage, tocPageSize, mergeQuery) {
  const tocChildren = elements["toc-list"].children;
  const start = (tocPage - 1) * tocPageSize;
  const end = Math.min(chapters.length, start + tocPageSize);

  for (let i = start; i < end; i++) {
    const id = `ti-${i}`;
    elements[id] = {
      type: "Button",
      props: {
        label: formatTocLabel(i + 1, chapters[i].title),
        variant: i === chapterIdx ? "primary" : "secondary",
      },
      on: { press: { action: "navigate", params: { query: mergeQuery({ chapter: i + 1, toc: "0", tocPage }) } } },
      children: [],
    };
    tocChildren.push(id);
  }
}

function formatTocLabel(index, title) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const clipped = cleanTitle.length > 10 ? `${cleanTitle.slice(0, 10)}...` : cleanTitle;
  return `${index}. ${clipped || "未命名章节"}`;
}
