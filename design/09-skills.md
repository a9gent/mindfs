# 技能系统

对应代码：`server/internal/skills/`

---

## 目录自定义 Skill 调用机制

**核心思路**: Agent 启动目录设为 .mindfs/，通过 --add-dir 添加用户目录，Agent 可自己发现 skill

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Agent 启动与 Skill 发现                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  启动命令:                                                               │
│  claude --cwd /path/to/.mindfs --add-dir /path/to/user-dir             │
│                                                                         │
│  目录结构:                                                               │
│  .mindfs/                    ← Agent 工作目录                           │
│  ├── config.json             ← Agent 可读取 userDescription             │
│  ├── skills/                 ← Agent 可 ls 发现可用 skill               │
│  │   ├── download/                                                      │
│  │   │   └── config.json     ← Agent 可 cat 了解参数                    │
│  │   └── summarize/                                                     │
│  │       └── config.json                                                │
│  └── ...                                                                │
│                                                                         │
│  /path/to/user-dir/          ← 通过 --add-dir 添加，Agent 可访问        │
│  ├── novels/                                                            │
│  └── code/                                                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**好处**:
1. Agent 可自己 `ls skills/` 发现可用 skill
2. Agent 可自己 `cat skills/xxx/config.json` 了解 skill 参数
3. 不需要在上下文中传递 skill 列表
4. 不需要 MCP Server，简化架构
5. Agent 可读取 config.json 获取 userDescription

---

## Skill 执行方式

Agent 发现 skill 后，通过 Server API 调用执行（skill 执行涉及权限控制、审计等，不能让 Agent 直接执行）：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Skill 执行流程                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Agent 发现 skill                                                    │
│     $ ls skills/                                                        │
│     download/  summarize/                                               │
│                                                                         │
│  2. Agent 了解 skill 参数                                               │
│     $ cat skills/download/config.json                                   │
│     { "name": "下载", "params": [{ "name": "url", "type": "string" }] } │
│                                                                         │
│  3. Agent 调用 Server API 执行                                          │
│     POST http://localhost:8080/api/skills/download/execute              │
│     { "params": { "url": "https://..." } }                              │
│                                                                         │
│  4. Server 执行 skill 并返回结果                                         │
│     - 权限校验                                                          │
│     - 执行 handler                                                      │
│     - 记录审计日志                                                       │
│     - 返回结果给 Agent                                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Agent 配置

```json
// ~/.config/mindfs/agents.json
{
  "agents": {
    "claude": {
      "command": "claude",
      "cwdTemplate": "{root}/.mindfs",      // 工作目录模板
      "addDirArgs": ["--add-dir", "{root}"], // 添加用户目录
      "sessionArgs": ["--stdin", "--no-exit"],
      "probeArgs": ["--version"]
    },
    "codex": {
      "command": "codex",
      "cwdTemplate": "{root}/.mindfs",
      "addDirArgs": ["--include", "{root}"], // Codex 可能用不同参数
      "sessionArgs": ["--interactive"],
      "probeArgs": ["--help"]
    }
  }
}
```

---

## 启动流程

```go
func (p *AgentPool) CreateProcess(agent string, rootPath string) (*AgentProcess, error) {
    config := p.configs[agent]

    // 构建工作目录
    cwd := strings.Replace(config.CwdTemplate, "{root}", rootPath, -1)

    // 构建参数
    args := make([]string, 0)
    args = append(args, config.SessionArgs...)
    for _, arg := range config.AddDirArgs {
        args = append(args, strings.Replace(arg, "{root}", rootPath, -1))
    }

    cmd := exec.Command(config.Command, args...)
    cmd.Dir = cwd

    // ... 启动进程
}
```

---

## Skill 执行 API

```go
// POST /api/skills/:id/execute
func (h *Handler) ExecuteSkill(w http.ResponseWriter, r *http.Request) {
    skillID := chi.URLParam(r, "id")
    rootID := r.URL.Query().Get("root")

    var req struct {
        Params map[string]any `json:"params"`
    }
    json.NewDecoder(r.Body).Decode(&req)

    // 1. 加载 skill 配置
    skill, err := h.skillLoader.Load(rootID, skillID)
    if err != nil {
        http.Error(w, "skill not found", 404)
        return
    }

    // 2. 权限校验
    if err := h.permChecker.Check(skill.Permissions); err != nil {
        http.Error(w, "permission denied", 403)
        return
    }

    // 3. 执行 skill
    result, err := skill.Execute(req.Params)
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }

    // 4. 记录审计日志
    h.audit.Log(AuditEntry{
        Type:    "skill",
        Action:  "execute",
        SkillID: skillID,
        Params:  req.Params,
        Result:  result,
    })

    json.NewEncoder(w).Encode(result)
}
```

---

## 降级方案

如果 Agent 不支持 --add-dir 或类似机制，降级为在提示词中传递 skill 列表：

```typescript
// 在 System Prompt 中添加
const skillPrompt = `
你可以调用以下目录自定义技能 (通过 POST /api/skills/{id}/execute):

${skills.map(s => `- ${s.id}: ${s.description}
  参数: ${JSON.stringify(s.params)}`).join('\n')}
`;
```

---

## 目录自定义 Skill 列表

```typescript
// 仅列出目录自定义 skill，不包含 Agent 内置能力
interface SkillBrief {
  id: string;                        // skill ID
  name: string;                      // 显示名称
  description: string;               // 简短描述
  params?: ParamDef[];               // 参数定义
}

// 扫描 .mindfs/skills/ 目录获取
function loadDirectorySkills(rootPath: string): SkillBrief[] {
  const skillsDir = path.join(rootPath, ".mindfs/skills");
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir)
    .filter(name => fs.statSync(path.join(skillsDir, name)).isDirectory())
    .map(name => {
      const config = JSON.parse(
        fs.readFileSync(path.join(skillsDir, name, "config.json"), "utf-8")
      );
      return {
        id: name,
        name: config.name,
        description: config.description,
        params: config.params
      };
    });
}
```
