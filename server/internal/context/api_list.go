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
			Response: "{ file: { path, content, mime_type, size, file_meta[] } }",
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
			Path:        "session.message",
			Description: "发送消息",
			Params: []ParamDef{
				{Name: "session_key", Type: "string", Required: false, Description: "Session Key，可空（空时后端自动创建）"},
				{Name: "content", Type: "string", Required: true, Description: "消息内容"},
				{Name: "context", Type: "ClientContext", Required: false, Description: "客户端上下文"},
				{Name: "type", Type: "string", Required: true, Description: "会话类型（前端必传）"},
				{Name: "agent", Type: "string", Required: true, Description: "会话 Agent（前端必传）"},
			},
			Response: "session.stream { session_key, event { type, data } } -> session.done { session_key }",
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
