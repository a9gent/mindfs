package context

func LoadCatalog() (ComponentCatalog, RegistrySchema) {
	catalog := ComponentCatalog{
		Version: "1.0",
		Components: map[string]ComponentSpec{
			"Shell":           {Description: "App shell layout", Props: map[string]any{"hasChildren": true}},
			"Sidebar":         {Description: "Left sidebar", Props: map[string]any{"slot": "sidebar"}},
			"Main":            {Description: "Main view area", Props: map[string]any{"slot": "main"}},
			"Footer":          {Description: "Footer area", Props: map[string]any{"slot": "footer"}},
			"RightSidebar":    {Description: "Right sidebar", Props: map[string]any{"slot": "right", "collapsed": "boolean"}},
			"FileTree":        {Description: "File tree", Props: map[string]any{"entries": "FileEntry[]"}},
			"DefaultListView": {Description: "Default list", Props: map[string]any{"entries": "FileEntry[]"}},
			"FileViewer":      {Description: "File viewer", Props: map[string]any{"file": "File"}},
			"ActionBar":       {Description: "Action bar", Props: map[string]any{"status": "string"}},
			"SessionList":     {Description: "Session list", Props: map[string]any{"sessions": "Session[]"}},
			"SessionViewer":   {Description: "Session viewer", Props: map[string]any{"session": "Session"}},
		},
	}

	schema := RegistrySchema{
		"FileEntry": map[string]any{"name": "string", "path": "string", "is_dir": "boolean"},
		"File": map[string]any{
			"name": "string", "path": "string", "content": "string", "encoding": "string",
			"truncated": "boolean", "size": "number", "ext": "string", "mime": "string",
		},
		"Session": map[string]any{
			"session_key": "string", "agent": "string", "scope": "string", "purpose": "string",
			"summary": "string", "closed_at": "string",
		},
	}
	return catalog, schema
}
