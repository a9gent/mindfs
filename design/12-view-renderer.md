# 视图渲染系统

对应代码：`web/src/renderer/`

---

## 组件 Catalog

组件白名单，定义可用的 UI 组件及其属性。基于 json-render 框架实现。

```typescript
interface ComponentCatalog {
  version: string;
  components: {
    [name: string]: {
      description: string;
      props: z.ZodType;              // Zod schema for props validation
      events?: string[];             // 支持的事件列表 (如 "press", "change")
      slots?: string[];              // 支持的插槽列表 (如 "default")
    };
  };
  actions: {
    [name: string]: {
      params: z.ZodType;             // Zod schema for params validation
      description: string;
    };
  };
}
```

示例：

```json
{
  "version": "1.0",
  "components": {
    "Text": {
      "description": "文本显示组件",
      "props": {
        "content": { "type": "string", "required": true },
        "size": { "type": "enum", "values": ["small", "medium", "large"] },
        "color": { "type": "string" }
      }
    },
    "Button": {
      "description": "按钮组件",
      "props": {
        "label": { "type": "string", "required": true },
        "variant": { "type": "enum", "values": ["primary", "secondary"] }
      },
      "events": ["press"]
    },
    "List": {
      "description": "列表组件",
      "props": {
        "items": { "type": "array", "required": true }
      },
      "slots": ["default"]
    }
  },
  "actions": {
    "setState": {
      "params": {
        "path": { "type": "string", "required": true },
        "value": { "type": "any", "required": true }
      },
      "description": "更新状态模型中指定路径的值"
    },
    "navigate": {
      "params": {
        "path": { "type": "string", "required": true }
      },
      "description": "导航到指定路径"
    }
  }
}
```

---

## Registry Schema

组件 props 的详细 Schema 定义：

```typescript
interface RegistrySchema {
  [componentName: string]: {
    props: {
      [propName: string]: {
        type: string;
        required?: boolean;
        default?: any;
        description?: string;
        enum?: string[];
      };
    };
  };
}
```

---

## 视图数据模型

AI 生成的视图数据结构，基于 json-render 的 Spec 格式：

```typescript
interface Spec {
  root: string;                           // 根元素 key
  elements: Record<string, UIElement>;    // 扁平化的元素映射
  state?: Record<string, unknown>;        // 初始状态数据
}

interface UIElement<T extends string = string, P = Record<string, unknown>> {
  type: T;                                // 组件类型
  props: P;                               // 组件属性
  children?: string[];                    // 子元素 keys
  visible?: VisibilityCondition;          // 可见性条件
  on?: Record<string, ActionBinding | ActionBinding[]>;  // 事件绑定
  repeat?: { path: string; key?: string }; // 列表渲染
}

interface ActionBinding {
  action: string;                         // Action 名称
  params?: Record<string, DynamicValue>;  // 参数（支持动态值）
  confirm?: ActionConfirm;                // 确认对话框
  onSuccess?: ActionOnSuccess;            // 成功回调
  onError?: ActionOnError;                // 错误回调
}

type DynamicValue<T = unknown> = T | { path: string };  // 字面量或状态路径引用
```

示例视图：

```json
{
  "root": "container",
  "elements": {
    "container": {
      "type": "Stack",
      "props": { "direction": "vertical", "gap": "md" },
      "children": ["title", "content", "nav"]
    },
    "title": {
      "type": "Heading",
      "props": {
        "text": { "path": "/title" },
        "level": "h1"
      }
    },
    "content": {
      "type": "Text",
      "props": {
        "text": { "path": "/content" }
      }
    },
    "nav": {
      "type": "Stack",
      "props": { "direction": "horizontal", "justify": "center", "gap": "md" },
      "children": ["prevBtn", "pageInfo", "nextBtn"]
    },
    "prevBtn": {
      "type": "Button",
      "props": { "label": "上一章", "variant": "secondary" },
      "on": {
        "press": {
          "action": "loadChapter",
          "params": {
            "path": { "path": "/prevChapterPath" }
          }
        }
      }
    },
    "pageInfo": {
      "type": "Text",
      "props": {
        "text": { "path": "/pageInfo" }
      }
    },
    "nextBtn": {
      "type": "Button",
      "props": { "label": "下一章", "variant": "primary" },
      "on": {
        "press": {
          "action": "loadChapter",
          "params": {
            "path": { "path": "/nextChapterPath" }
          }
        }
      }
    }
  },
  "state": {
    "title": "第一章",
    "content": "章节内容...",
    "pageInfo": "1 / 10",
    "prevChapterPath": "/novels/ch0.txt",
    "nextChapterPath": "/novels/ch2.txt"
  }
}
```

---

## 动态组件加载

基于 json-render 的 Renderer 实现，使用 React Context 管理状态和 action。

### Renderer 组件

```tsx
import { Renderer, StateProvider, VisibilityProvider, ActionProvider } from '@json-render/react';
import type { Spec } from '@json-render/core';

interface ViewRendererProps {
  spec: Spec;
  registry: Record<string, React.ComponentType<any>>;
  actionHandlers: Record<string, (params: Record<string, unknown>) => void | Promise<void>>;
}

function ViewRenderer({ spec, registry, actionHandlers }: ViewRendererProps) {
  return (
    <StateProvider initialState={spec.state}>
      <VisibilityProvider>
        <ActionProvider handlers={actionHandlers}>
          <Renderer
            spec={spec}
            registry={registry}
            fallback={(props) => <div>Unknown component: {props.element.type}</div>}
          />
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}
```

### 动态值解析

json-render 自动解析动态值，无需手动处理：

```typescript
// 组件 props 中的动态值
{
  "type": "Text",
  "props": {
    "text": { "path": "/title" }  // 自动从 state.title 读取
  }
}

// Action params 中的动态值
{
  "on": {
    "press": {
      "action": "loadChapter",
      "params": {
        "path": { "path": "/nextChapterPath" }  // 自动从 state.nextChapterPath 读取
      }
    }
  }
}
```

### Action 处理

Action handlers 在 ActionProvider 中注册：

```typescript
const actionHandlers = {
  // 状态更新
  setState: ({ path, value }: { path: string; value: unknown }) => {
    // json-render 内置，自动处理
  },

  // 自定义 action
  loadChapter: async ({ path }: { path: string }) => {
    const response = await fetch(`/api/file?path=${path}`);
    const data = await response.json();

    // 更新状态触发重新渲染
    setState('/title', data.title);
    setState('/content', data.content);
  },

  // 导航 action
  navigate: ({ path }: { path: string }) => {
    window.location.href = path;
  }
};
```

---

## 组件注册表

```typescript
// web/src/renderer/registry.tsx
import { Text } from './components/Text';
import { Button } from './components/Button';
import { Container } from './components/Container';
import { List } from './components/List';
import { ButtonGroup } from './components/ButtonGroup';

export const registry: Record<string, React.ComponentType<any>> = {
  Text,
  Button,
  Container,
  List,
  ButtonGroup,
  // ... 更多组件
};
```

---

## 视图示例 (Few-shot)

用于提高 AI 生成视图的质量：

```typescript
interface ViewExample {
  description: string;               // 场景描述
  prompt: string;                    // 用户提示词
  view: ViewDefinition;              // 生成的视图数据
}
```

示例：

```json
{
  "description": "小说阅读器，支持章节导航",
  "prompt": "生成一个小说阅读器视图，显示标题、内容，底部有上一章/下一章按钮",
  "view": {
    "id": "novels-reader",
    "name": "小说阅读器",
    "tree": { "..." }
  }
}
```

这些示例会在视图生成模式下作为 few-shot 提示传递给 Agent。
