import { z } from "zod";

// 仅保留基础组件校验，移除布局组件。
// AI 定制视图通常只需要 Container, AssociationView, Button, Markdown 等功能性组件。

export const ComponentSchema = z.object({
  type: z.string(),
  props: z.record(z.string(), z.any()).optional(),
  children: z.array(z.string()).optional(),
});

export const UITreeSchema = z.object({
  root: z.string(),
  elements: z.record(z.string(), ComponentSchema),
  state: z.record(z.string(), z.any()).optional(),
});

// 定义可序列化的 Action 校验，替代 z.any() 函数
export const ActionSchema = z.object({
  action: z.string(),
  params: z.record(z.string(), z.any()).optional(),
});
