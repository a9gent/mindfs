import { useCallback, useState } from "react";

/**
 * 刷新按钮通用反馈：按下背景高亮 + 刷新中旋转动画。
 *
 * 刷新请求在本地通常 ~10ms 完成，refreshing 若随即复位，旋转动画根本来不及显示，
 * 因此保证 refreshing 至少持续 `minDurationMs`（默认 450ms）才复位。
 *
 * 复用：FileTree 侧边栏刷新按钮、任务面板刷新按钮。
 */
export function useRefreshSpin(
  onRefresh?: () => void | Promise<void>,
  minDurationMs = 450,
) {
  const [refreshing, setRefreshing] = useState(false);
  const [pressed, setPressed] = useState(false);

  const handleClick = useCallback(async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    const startedAt = Date.now();
    try {
      await onRefresh();
    } finally {
      const remaining = Math.max(0, minDurationMs - (Date.now() - startedAt));
      window.setTimeout(() => setRefreshing(false), remaining);
    }
  }, [onRefresh, refreshing, minDurationMs]);

  return { refreshing, pressed, setPressed, handleClick };
}
