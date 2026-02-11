package context

import "time"

type ClientContext struct {
	CurrentRoot string          `json:"current_root"`
	CurrentPath string          `json:"current_path,omitempty"`
	Selection   *Selection      `json:"selection,omitempty"`
	CurrentView *CurrentViewRef `json:"current_view,omitempty"`
}

type Selection struct {
	FilePath string `json:"file_path"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Text     string `json:"text"`
}

type CurrentViewRef struct {
	RuleID string `json:"rule_id"`
}

type ServerContext struct {
	Common CommonContext `json:"common"`
	View   *ViewContext  `json:"view,omitempty"`
	Skill  *SkillContext `json:"skill,omitempty"`
}

type CommonContext struct {
	RootPath        string         `json:"root_path"`
	UserDescription string         `json:"user_description,omitempty"`
	RelatedSessions []SessionBrief `json:"related_sessions,omitempty"`
}

type ViewContext struct {
	Catalog        ComponentCatalog `json:"catalog"`
	RegistrySchema RegistrySchema   `json:"registry_schema"`
	ServerAPIs     []APIEndpoint    `json:"server_apis"`
	CurrentView    *ViewDefinition  `json:"current_view,omitempty"`
	ViewExamples   []ViewExample    `json:"view_examples,omitempty"`
}

type SkillContext struct {
	DirectorySkills []SkillBrief `json:"directory_skills,omitempty"`
}

type SessionBrief struct {
	Key          string    `json:"key"`
	Type         string    `json:"type"`
	Name         string    `json:"name"`
	Status       string    `json:"status"`
	UpdatedAt    time.Time `json:"updated_at"`
	RelatedFiles []string  `json:"related_files"`
}

type ComponentCatalog struct {
	Version    string                   `json:"version"`
	Components map[string]ComponentSpec `json:"components"`
}

type ComponentSpec struct {
	Description string                 `json:"description"`
	Props       map[string]any         `json:"props"`
	Actions     []string               `json:"actions,omitempty"`
}

type RegistrySchema map[string]any

type APIEndpoint struct {
	Method      string     `json:"method"`
	Path        string     `json:"path"`
	Description string     `json:"description"`
	Params      []ParamDef `json:"params,omitempty"`
	Response    string     `json:"response,omitempty"`
}

type ViewExample struct {
	Description string         `json:"description"`
	Prompt      string         `json:"prompt"`
	View        map[string]any `json:"view"`
}

type ViewDefinition struct {
	RuleID string `json:"rule_id"`
}

type SkillBrief struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Params      []ParamDef `json:"params,omitempty"`
}

type ParamDef struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Required    bool   `json:"required,omitempty"`
	Description string `json:"description,omitempty"`
}
