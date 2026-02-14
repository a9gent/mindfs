package context

import (
	"fmt"

	"mindfs/server/internal/fs"
)

func BuildServerContext(mode string, root fs.RootInfo, currentView *CurrentViewRef) (ServerContext, error) {
	rootPath, _ := root.RootDir()

	ctx := ServerContext{
		Common: CommonContext{
			RootPath: rootPath,
		},
	}

	switch mode {
	case "view":
		catalog, schema := LoadCatalog()
		apis := LoadAPIList()
		apis = append(apis, LoadWSActions()...)
		examples, err := LoadViewExamples("")
		if err != nil {
			examples = []ViewExample{}
		}
		var viewDef *ViewDefinition
		if currentView != nil {
			viewDef = &ViewDefinition{
				RuleID: currentView.RuleID,
			}
		}
		ctx.View = &ViewContext{
			Catalog:        catalog,
			RegistrySchema: schema,
			ServerAPIs:     apis,
			CurrentView:    viewDef,
			ViewExamples:   SelectExamples(examples, "", 3),
		}
	case "skill":
		dirSkills, err := LoadDirectorySkills(root)
		if err != nil {
			return ctx, fmt.Errorf("load directory skills: %w", err)
		}
		ctx.Skill = &SkillContext{DirectorySkills: dirSkills}
	}

	return ctx, nil
}
