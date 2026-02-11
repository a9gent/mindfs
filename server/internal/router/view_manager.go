package router

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

	"mindfs/server/internal/fs"
)

type ViewRoute struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Match    MatchRule `json:"match"`
	View     string    `json:"view,omitempty"`
	ViewData any       `json:"view_data,omitempty"`
	Priority int       `json:"priority"`
	Default  bool      `json:"default,omitempty"`
}

type MatchRule struct {
	Path string      `json:"path,omitempty"`
	Ext  string      `json:"ext,omitempty"`
	Mime string      `json:"mime,omitempty"`
	Name string      `json:"name,omitempty"`
	Any  []MatchRule `json:"any,omitempty"`
	All  []MatchRule `json:"all,omitempty"`
}

type ViewRouterConfig struct {
	Routes []ViewRoute `json:"routes"`
}

type ViewPreference struct {
	LastSelected map[string]string `json:"last_selected"`
}

type ResolvedView struct {
	RouteID   string         `json:"route_id"`
	RouteName string         `json:"route_name"`
	Priority  int            `json:"priority"`
	IsDefault bool           `json:"is_default"`
	ViewData  map[string]any `json:"view_data,omitempty"`
}

type ViewManager struct {
	root fs.RootInfo
}

func NewViewManager(root fs.RootInfo) (*ViewManager, error) {
	if root.MetaDir() == "" {
		return nil, errors.New("meta dir required")
	}
	return &ViewManager{root: root}, nil
}

func (m *ViewManager) Root() fs.RootInfo { return m.root }

func (m *ViewManager) Routes(path string) ([]ResolvedView, error) {
	cfg, err := loadViewRouterConfig(m.root)
	if err != nil {
		return nil, err
	}
	var routes []ViewRoute
	if path != "" {
		routes = cfg.getMatchingRoutes(path)
	} else {
		routes = cfg.Routes
		sort.Slice(routes, func(i, j int) bool { return routes[i].Priority > routes[j].Priority })
	}
	views := make([]ResolvedView, 0, len(routes))
	for _, route := range routes {
		view := ResolvedView{RouteID: route.ID, RouteName: route.Name, Priority: route.Priority, IsDefault: route.Default}
		if route.ViewData != nil {
			if data, ok := route.ViewData.(map[string]any); ok {
				view.ViewData = data
			}
		} else if route.View != "" {
			data, _ := m.loadViewFile(route.View)
			view.ViewData = data
		}
		views = append(views, view)
	}
	return views, nil
}

func (m *ViewManager) SetPreference(path, routeID string) error {
	pref, err := loadViewPreference(m.root)
	if err != nil {
		return err
	}
	if path != "" {
		pref.LastSelected[path] = routeID
	}
	return saveViewPreference(m.root, pref)
}

func (m *ViewManager) loadViewFile(viewPath string) (map[string]any, error) {
	if filepath.IsAbs(viewPath) {
		return nil, errors.New("absolute view path not allowed")
	}
	data, err := m.root.ReadMetaFile(filepath.Join("views", viewPath))
	if err != nil {
		return nil, err
	}
	var viewData map[string]any
	if err := json.Unmarshal(data, &viewData); err != nil {
		return nil, err
	}
	return viewData, nil
}

func loadViewRouterConfig(root fs.RootInfo) (*ViewRouterConfig, error) {
	data, err := root.ReadMetaFile("view-routes.json")
	if err != nil {
		if os.IsNotExist(err) {
			return defaultViewRouterConfig(), nil
		}
		return nil, err
	}
	var config ViewRouterConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	return &config, nil
}

func defaultViewRouterConfig() *ViewRouterConfig {
	return &ViewRouterConfig{Routes: []ViewRoute{{ID: "_default", Name: "默认视图", Match: MatchRule{Path: "**/*"}, Priority: 0, Default: true}}}
}

func (c *ViewRouterConfig) getMatchingRoutes(path string) []ViewRoute {
	var matches []ViewRoute
	for _, route := range c.Routes {
		if matchesRule(path, route.Match) {
			matches = append(matches, route)
		}
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].Priority > matches[j].Priority })
	return matches
}

func loadViewPreference(root fs.RootInfo) (*ViewPreference, error) {
	data, err := root.ReadMetaFile("view-preference.json")
	if err != nil {
		if os.IsNotExist(err) {
			return &ViewPreference{LastSelected: make(map[string]string)}, nil
		}
		return nil, err
	}
	var pref ViewPreference
	if err := json.Unmarshal(data, &pref); err != nil {
		return nil, err
	}
	if pref.LastSelected == nil {
		pref.LastSelected = make(map[string]string)
	}
	return &pref, nil
}

func saveViewPreference(root fs.RootInfo, pref *ViewPreference) error {
	data, err := json.MarshalIndent(pref, "", "  ")
	if err != nil {
		return err
	}
	return root.WriteMetaFile("view-preference.json", data)
}
