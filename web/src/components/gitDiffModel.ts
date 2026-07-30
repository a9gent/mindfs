import { diffArrays, diffWordsWithSpace } from "diff";

export type DiffLine = {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type InlineDiffSegment = {
  kind: "ctx" | "add" | "del";
  text: string;
};

export type SideBySideDiffRow = {
  kind: "hunk" | "change" | "ctx";
  hunkText?: string;
  left?: DiffLine;
  right?: DiffLine;
};

export type UnifiedDiffRow =
  | { kind: "hunk"; hunkText: string }
  | { kind: "line"; line: DiffLine; counterpart?: DiffLine };

export type DiffCodeRow = {
  kind: "meta" | "hunk" | "ctx" | "add" | "del";
  text: string;
  segments?: InlineDiffSegment[];
};

export function buildDiffLines(content: string): DiffLine[] {
  const source = String(content || "").split("\n");
  const filtered = source.filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  filtered.forEach((line) => {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10) || 0;
      newLine = Number.parseInt(hunkMatch[2], 10) || 0;
      lines.push({ kind: "hunk", text: line });
      return;
    }
    if (/^\+[^+]/.test(line)) {
      lines.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
      return;
    }
    if (/^-[^-]/.test(line)) {
      lines.push({ kind: "del", text: line.slice(1), oldLine });
      oldLine += 1;
      return;
    }
    lines.push({
      kind: "ctx",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldLine: oldLine || undefined,
      newLine: newLine || undefined,
    });
    if (oldLine > 0) {
      oldLine += 1;
    }
    if (newLine > 0) {
      newLine += 1;
    }
  });

  return lines;
}

export function buildSideBySideRows(lines: DiffLine[]): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk") {
      rows.push({ kind: "hunk", hunkText: line.text });
      index += 1;
      continue;
    }
    if (line.kind === "ctx") {
      rows.push({ kind: "ctx", left: line, right: line });
      index += 1;
      continue;
    }
    if (line.kind === "del" || line.kind === "add") {
      const deleted: DiffLine[] = [];
      const added: DiffLine[] = [];
      while (index < lines.length && (lines[index].kind === "del" || lines[index].kind === "add")) {
        const current = lines[index];
        if (current.kind === "del") {
          deleted.push(current);
        } else {
          added.push(current);
        }
        index += 1;
      }
      rows.push(...alignChangeBlock(deleted, added));
      continue;
    }
    index += 1;
  }

  return rows;
}

export function getInlineDiffSegments(oldText: string, newText: string): InlineDiffSegment[] {
  const segments: InlineDiffSegment[] = diffArrays(tokenizeInline(oldText), tokenizeInline(newText)).map((part) => {
    const kind: InlineDiffSegment["kind"] = part.added ? "add" : part.removed ? "del" : "ctx";
    return {
      kind,
      text: part.value.join(""),
    };
  });
  return mergeAdjacentSegments(segments);
}

export function buildUnifiedRows(lines: DiffLine[]): UnifiedDiffRow[] {
  return buildSideBySideRows(lines).flatMap((row): UnifiedDiffRow[] => {
    if (row.kind === "hunk") {
      return [{ kind: "hunk", hunkText: row.hunkText || "" }];
    }
    if (row.kind === "ctx" && row.right) {
      return [{ kind: "line", line: row.right }];
    }
    if (row.left && row.right && isWhitespaceOnlyChange(row.left.text, row.right.text)) {
      return [{
        kind: "line",
        line: {
          ...row.right,
          kind: "ctx",
          oldLine: row.left.oldLine,
        },
      }];
    }
    const rows: UnifiedDiffRow[] = [];
    if (row.left) {
      rows.push({ kind: "line", line: row.left, counterpart: row.right });
    }
    if (row.right) {
      rows.push({ kind: "line", line: row.right, counterpart: row.left });
    }
    return rows;
  });
}

export function buildDiffCodeRows(content: string): DiffCodeRow[] {
  const metaRows = String(content || "")
    .split("\n")
    .filter((line) => /^(diff --git|index |--- |\+\+\+ )/.test(line))
    .map((line): DiffCodeRow => ({ kind: "meta", text: line }));

  const diffRows = buildUnifiedRows(buildDiffLines(content)).map((row): DiffCodeRow => {
    if (row.kind === "hunk") {
      return { kind: "hunk", text: row.hunkText };
    }
    const line = row.line;
    return {
      kind: line.kind === "add" ? "add" : line.kind === "del" ? "del" : "ctx",
      text: line.text,
      segments: buildVisibleInlineSegments(line, row.counterpart),
    };
  });

  return [...metaRows, ...diffRows];
}

function alignChangeBlock(deleted: DiffLine[], added: DiffLine[]): SideBySideDiffRow[] {
  if (deleted.length === 0) {
    return added.map((right) => ({ kind: "change", right }));
  }
  if (added.length === 0) {
    return deleted.map((left) => ({ kind: "change", left }));
  }

  const pairs = findSimilarLinePairs(deleted, added);
  const rows: SideBySideDiffRow[] = [];
  let deletedIndex = 0;
  let addedIndex = 0;

  pairs.forEach(([nextDeletedIndex, nextAddedIndex]) => {
    while (deletedIndex < nextDeletedIndex || addedIndex < nextAddedIndex) {
      if (deletedIndex < nextDeletedIndex && addedIndex < nextAddedIndex) {
        rows.push({ kind: "change", left: deleted[deletedIndex], right: added[addedIndex] });
        deletedIndex += 1;
        addedIndex += 1;
      } else if (deletedIndex < nextDeletedIndex) {
        rows.push({ kind: "change", left: deleted[deletedIndex] });
        deletedIndex += 1;
      } else {
        rows.push({ kind: "change", right: added[addedIndex] });
        addedIndex += 1;
      }
    }
    rows.push(buildPairedChangeRow(deleted[nextDeletedIndex], added[nextAddedIndex]));
    deletedIndex = nextDeletedIndex + 1;
    addedIndex = nextAddedIndex + 1;
  });

  while (deletedIndex < deleted.length || addedIndex < added.length) {
    if (deletedIndex < deleted.length && addedIndex < added.length) {
      rows.push(buildPairedChangeRow(deleted[deletedIndex], added[addedIndex]));
      deletedIndex += 1;
      addedIndex += 1;
    } else if (deletedIndex < deleted.length) {
      rows.push({ kind: "change", left: deleted[deletedIndex] });
      deletedIndex += 1;
    } else {
      rows.push({ kind: "change", right: added[addedIndex] });
      addedIndex += 1;
    }
  }

  return rows;
}

function buildVisibleInlineSegments(line: DiffLine, counterpart?: DiffLine): InlineDiffSegment[] | undefined {
  if (!counterpart || line.kind === "ctx" || counterpart.kind === "ctx") {
    return undefined;
  }
  const oldText = line.kind === "del" ? line.text : counterpart.text;
  const newText = line.kind === "add" ? line.text : counterpart.text;
  const hiddenKind = line.kind === "add" ? "del" : "add";
  return getInlineDiffSegments(oldText, newText).filter((segment) => segment.kind !== hiddenKind);
}

function buildPairedChangeRow(left: DiffLine, right: DiffLine): SideBySideDiffRow {
  if (isWhitespaceOnlyChange(left.text, right.text)) {
    const ctxLine: DiffLine = {
      ...right,
      kind: "ctx",
      oldLine: left.oldLine,
    };
    return { kind: "ctx", left: ctxLine, right: ctxLine };
  }
  return { kind: "change", left, right };
}

function findSimilarLinePairs(deleted: DiffLine[], added: DiffLine[]): Array<[number, number]> {
  const score = deleted.map((left) => added.map((right) => lineSimilarity(left.text, right.text)));
  const dp = Array.from({ length: deleted.length + 1 }, () => Array<number>(added.length + 1).fill(0));

  for (let left = 1; left <= deleted.length; left += 1) {
    for (let right = 1; right <= added.length; right += 1) {
      const pairScore = score[left - 1][right - 1] >= 0.48 ? score[left - 1][right - 1] : Number.NEGATIVE_INFINITY;
      dp[left][right] = Math.max(
        dp[left - 1][right],
        dp[left][right - 1],
        Number.isFinite(pairScore) ? dp[left - 1][right - 1] + pairScore : Number.NEGATIVE_INFINITY,
      );
    }
  }

  const pairs: Array<[number, number]> = [];
  let left = deleted.length;
  let right = added.length;
  while (left > 0 && right > 0) {
    const pairScore = score[left - 1][right - 1];
    if (pairScore >= 0.48 && nearlyEqual(dp[left][right], dp[left - 1][right - 1] + pairScore)) {
      pairs.push([left - 1, right - 1]);
      left -= 1;
      right -= 1;
    } else if (dp[left - 1][right] >= dp[left][right - 1]) {
      left -= 1;
    } else {
      right -= 1;
    }
  }

  return pairs.reverse();
}

function lineSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeLine(left);
  const normalizedRight = normalizeLine(right);
  if (normalizedLeft === normalizedRight) {
    return 1;
  }
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  const leftTokens = tokenSet(normalizedLeft);
  const rightTokens = tokenSet(normalizedRight);
  const common = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = union === 0 ? 0 : common / union;

  const commonChars = diffWordsWithSpace(normalizedLeft, normalizedRight)
    .filter((part) => !part.added && !part.removed)
    .reduce((total, part) => total + part.value.length, 0);
  const charScore = (commonChars * 2) / (normalizedLeft.length + normalizedRight.length);

  return Math.max(tokenScore, charScore);
}

function normalizeLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isWhitespaceOnlyChange(left: string, right: string): boolean {
  return left !== right && left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
}

function tokenSet(value: string): Set<string> {
  return new Set(value.match(/[A-Za-z0-9_.$]+|[^\sA-Za-z0-9_.$]/g) || []);
}

function tokenizeInline(value: string): string[] {
  return value.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+|\s+|./g) || [];
}

function mergeAdjacentSegments(segments: InlineDiffSegment[]): InlineDiffSegment[] {
  const merged: InlineDiffSegment[] = [];
  segments.forEach((segment) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === segment.kind) {
      previous.text += segment.text;
      return;
    }
    merged.push({ ...segment });
  });
  return merged;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000001;
}
