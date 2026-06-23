package acp

import (
	"strings"

	types "mindfs/server/internal/agent/types"

	acpsdk "github.com/coder/acp-go-sdk"
)

func cloneConfigOptions(options []acpsdk.SessionConfigOption) []acpsdk.SessionConfigOption {
	if len(options) == 0 {
		return nil
	}
	return append([]acpsdk.SessionConfigOption(nil), options...)
}

func findSelectConfigOption(options []acpsdk.SessionConfigOption, category acpsdk.SessionConfigOptionCategory) (acpsdk.SessionConfigOptionSelect, bool) {
	for _, option := range options {
		if option.Select == nil || option.Select.Category == nil {
			continue
		}
		if *option.Select.Category == category {
			return *option.Select, true
		}
	}
	return acpsdk.SessionConfigOptionSelect{}, false
}

func hasSelectConfigOption(options []acpsdk.SessionConfigOption, category acpsdk.SessionConfigOptionCategory) bool {
	_, ok := findSelectConfigOption(options, category)
	return ok
}

func configOptionCurrentValue(options []acpsdk.SessionConfigOption, category acpsdk.SessionConfigOptionCategory) string {
	option, ok := findSelectConfigOption(options, category)
	if !ok {
		return ""
	}
	return strings.TrimSpace(string(option.CurrentValue))
}

func mapModelConfigOptions(options []acpsdk.SessionConfigOption) types.ModelList {
	option, ok := findSelectConfigOption(options, acpsdk.SessionConfigOptionCategoryModel)
	if !ok {
		return types.ModelList{}
	}
	models := make([]types.ModelInfo, 0)
	supportEffort := hasSelectConfigOption(options, acpsdk.SessionConfigOptionCategoryThoughtLevel)
	for _, value := range flattenSelectOptions(option.Options) {
		id := strings.TrimSpace(string(value.Value))
		if id == "" {
			continue
		}
		models = append(models, types.ModelInfo{
			ID:            id,
			Name:          firstNonEmpty(strings.TrimSpace(value.Name), id),
			Description:   stringPtrValue(value.Description),
			SupportEffort: supportEffort,
		})
	}
	return types.ModelList{
		CurrentModelID: strings.TrimSpace(string(option.CurrentValue)),
		Models:         models,
	}
}

func mapModeConfigOptions(options []acpsdk.SessionConfigOption) types.ModeList {
	option, ok := findSelectConfigOption(options, acpsdk.SessionConfigOptionCategoryMode)
	if !ok {
		return types.ModeList{}
	}
	modes := make([]types.ModeInfo, 0)
	for _, value := range flattenSelectOptions(option.Options) {
		id := strings.TrimSpace(string(value.Value))
		if id == "" {
			continue
		}
		modes = append(modes, types.ModeInfo{
			ID:          id,
			Name:        firstNonEmpty(strings.TrimSpace(value.Name), id),
			Description: stringPtrValue(value.Description),
		})
	}
	return types.ModeList{
		CurrentModeID: strings.TrimSpace(string(option.CurrentValue)),
		Modes:         modes,
	}
}

func flattenSelectOptions(options acpsdk.SessionConfigSelectOptions) []acpsdk.SessionConfigSelectOption {
	if options.Ungrouped != nil {
		return append([]acpsdk.SessionConfigSelectOption(nil), (*options.Ungrouped)...)
	}
	if options.Grouped == nil {
		return nil
	}
	out := make([]acpsdk.SessionConfigSelectOption, 0)
	for _, group := range *options.Grouped {
		out = append(out, group.Options...)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func stringPtrValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
