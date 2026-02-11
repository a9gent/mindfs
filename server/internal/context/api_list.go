package context

func LoadAPIList() []APIEndpoint {
	return []APIEndpoint{
		// Session API
		{
			Method:      "GET",
			Path:        "/api/sessions",
			Description: "获取 Session 列表",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
			},
			Response: "{ sessions: Session[] }",
		},
		{
			Method:      "GET",
			Path:        "/api/sessions/:key",
			Description: "获取 Session 详情",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "key", Type: "string", Required: true, Description: "Session Key"},
			},
			Response: "{ session: Session }",
		},
		{
			Method:      "POST",
			Path:        "/api/sessions",
			Description: "创建 Session",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "type", Type: "string", Required: true, Description: "Session 类型: chat/view/skill"},
				{Name: "agent", Type: "string", Required: true, Description: "Agent 名称: claude/codex/gemini"},
				{Name: "name", Type: "string", Required: false, Description: "Session 名称"},
			},
			Response: "{ session: Session }",
		},
		{
			Method:      "POST",
			Path:        "/api/sessions/:key/message",
			Description: "发送消息到 Session",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "key", Type: "string", Required: true, Description: "Session Key"},
				{Name: "content", Type: "string", Required: true, Description: "消息内容"},
				{Name: "context", Type: "ClientContext", Required: false, Description: "客户端上下文"},
			},
			Response: "{ response: string, session: Session }",
		},
		// File API
		{
			Method:      "GET",
			Path:        "/api/file",
			Description: "获取文件内容",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "path", Type: "string", Required: true, Description: "文件相对路径"},
			},
			Response: "{ file: { path, content, mime_type, size } }",
		},
		{
			Method:      "GET",
			Path:        "/api/file/meta",
			Description: "获取文件元数据",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "path", Type: "string", Required: true, Description: "文件相对路径"},
			},
			Response: "{ meta: { source_session, created_at, created_by } }",
		},
		{
			Method:      "GET",
			Path:        "/api/tree",
			Description: "获取目录树",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "dir", Type: "string", Required: false, Description: "子目录路径，默认为根目录"},
			},
			Response: "{ tree: FileEntry[] }",
		},
		// View API
		{
			Method:      "GET",
			Path:        "/api/view/routes",
			Description: "获取匹配的视图路由列表（含视图数据）",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "path", Type: "string", Required: false, Description: "文件/目录路径，用于路由匹配"},
			},
			Response: "{ routes: ResolvedView[] }",
		},
		{
			Method:      "POST",
			Path:        "/api/view/preference",
			Description: "保存用户视图偏好",
			Params: []ParamDef{
				{Name: "root_id", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "path", Type: "string", Required: true, Description: "文件/目录路径"},
				{Name: "route_id", Type: "string", Required: true, Description: "视图路由 ID"},
			},
			Response: "{ status: \"ok\" }",
		},
		// Skill API
		{
			Method:      "GET",
			Path:        "/api/skills",
			Description: "获取可用技能列表",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
			},
			Response: "{ skills: SkillBrief[] }",
		},
		{
			Method:      "POST",
			Path:        "/api/skills/:id/execute",
			Description: "执行技能",
			Params: []ParamDef{
				{Name: "root", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "id", Type: "string", Required: true, Description: "技能 ID"},
				{Name: "params", Type: "object", Required: false, Description: "技能参数"},
			},
			Response: "{ result: any, files_created: string[] }",
		},
		// Dir Config API
		{
			Method:      "GET",
			Path:        "/api/dirs/:id/config",
			Description: "获取目录配置",
			Params: []ParamDef{
				{Name: "id", Type: "string", Required: true, Description: "管理目录 ID"},
			},
			Response: "{ config: DirConfig }",
		},
		{
			Method:      "PUT",
			Path:        "/api/dirs/:id/config",
			Description: "更新目录配置",
			Params: []ParamDef{
				{Name: "id", Type: "string", Required: true, Description: "管理目录 ID"},
				{Name: "user_description", Type: "string", Required: false, Description: "目录描述"},
				{Name: "default_agent", Type: "string", Required: false, Description: "默认 Agent"},
				{Name: "view_create_agent", Type: "string", Required: false, Description: "视图生成 Agent"},
			},
			Response: "{ config: DirConfig }",
		},
		// Agent API
		{
			Method:      "GET",
			Path:        "/api/agents",
			Description: "获取可用 Agent 列表",
			Params:      []ParamDef{},
			Response:    "{ agents: AgentStatus[] }",
		},
	}
}

func LoadWSActions() []APIEndpoint {
	return []APIEndpoint{
		// Session WebSocket
		{
			Method:      "WS",
			Path:        "session.create",
			Description: "创建 Session",
			Params: []ParamDef{
				{Name: "type", Type: "string", Required: true, Description: "Session 类型"},
				{Name: "agent", Type: "string", Required: true, Description: "Agent 名称"},
				{Name: "root_id", Type: "string", Required: true, Description: "管理目录 ID"},
			},
			Response: "session.created { session_key, name }",
		},
		{
			Method:      "WS",
			Path:        "session.message",
			Description: "发送消息",
			Params: []ParamDef{
				{Name: "session_key", Type: "string", Required: true, Description: "Session Key"},
				{Name: "content", Type: "string", Required: true, Description: "消息内容"},
				{Name: "context", Type: "ClientContext", Required: false, Description: "客户端上下文"},
			},
			Response: "session.stream { session_key, chunk } -> session.done { session_key }",
		},
		{
			Method:      "WS",
			Path:        "session.close",
			Description: "关闭 Session",
			Params: []ParamDef{
				{Name: "session_key", Type: "string", Required: true, Description: "Session Key"},
			},
			Response: "session.closed { session_key, summary }",
		},
		{
			Method:      "WS",
			Path:        "session.resume",
			Description: "恢复 Session",
			Params: []ParamDef{
				{Name: "session_key", Type: "string", Required: true, Description: "Session Key"},
			},
			Response: "session.resumed { session_key }",
		},
		// File WebSocket (Server -> Client push)
		{
			Method:      "WS",
			Path:        "file.created",
			Description: "文件创建通知 (服务端推送)",
			Params:      []ParamDef{},
			Response:    "{ path, session_key, size }",
		},
		{
			Method:      "WS",
			Path:        "file.changed",
			Description: "文件变更通知 (服务端推送)",
			Params:      []ParamDef{},
			Response:    "{ path, change_type }",
		},
	}
}
