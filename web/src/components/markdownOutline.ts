export type MarkdownOutlineItem = {
  id: string;
  level: number;
  title: string;
  sourceLine: number;
};

function plainHeadingText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function headingSlug(title: string): string {
  return title
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "section";
}

export function extractMarkdownOutline(content: string): MarkdownOutlineItem[] {
  const lines = content.split(/\r?\n/);
  const items: MarkdownOutlineItem[] = [];
  const slugCounts = new Map<string, number>();
  let fence: { marker: "`" | "~"; size: number } | null = null;

  const addHeading = (level: number, rawTitle: string, sourceLine: number) => {
    const title = plainHeadingText(rawTitle);
    if (!title) return;
    const slug = headingSlug(title);
    const count = (slugCounts.get(slug) || 0) + 1;
    slugCounts.set(slug, count);
    items.push({
      id: `markdown-heading-${slug}${count > 1 ? `-${count}` : ""}`,
      level,
      title,
      sourceLine,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) {
        fence = { marker, size: fenceMatch[1].length };
      } else if (marker === fence.marker && fenceMatch[1].length >= fence.size) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const atxMatch = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (atxMatch) {
      addHeading(atxMatch[1].length, atxMatch[2], index + 1);
      continue;
    }

    if (index + 1 < lines.length && line.trim()) {
      const setextMatch = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index + 1]);
      if (setextMatch) {
        addHeading(setextMatch[1][0] === "=" ? 1 : 2, line, index + 1);
        index += 1;
      }
    }
  }

  return items;
}
