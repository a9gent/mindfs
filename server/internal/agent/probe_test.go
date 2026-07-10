package agent

import (
	"reflect"
	"testing"

	agenttypes "mindfs/server/internal/agent/types"
)

func TestInferAgentEffortsUsesModelCatalog(t *testing.T) {
	models := []agenttypes.ModelInfo{
		{
			ID:            "gpt-5.6-sol",
			SupportEffort: true,
			Efforts:       []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		},
		{
			ID:            "gpt-5.6-terra",
			SupportEffort: true,
			Efforts:       []string{"medium", "ultra"},
		},
	}

	got := inferAgentEfforts(models)
	want := []string{"low", "medium", "high", "xhigh", "max", "ultra"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("inferAgentEfforts() = %#v, want %#v", got, want)
	}
}

func TestInferAgentEffortsKeepsLegacyFallback(t *testing.T) {
	got := inferAgentEfforts([]agenttypes.ModelInfo{{
		ID:            "legacy-codex",
		SupportEffort: true,
	}})
	want := []string{"low", "medium", "high", "xhigh"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("inferAgentEfforts() = %#v, want %#v", got, want)
	}
}

func TestStatusChangedDetectsModelEffortMetadata(t *testing.T) {
	previous := Status{Models: []agenttypes.ModelInfo{{
		ID:            "gpt-5.6-sol",
		SupportEffort: true,
		Efforts:       []string{"low", "medium"},
		DefaultEffort: "low",
	}}}
	next := previous
	next.Models = append([]agenttypes.ModelInfo(nil), previous.Models...)
	next.Models[0].Efforts = []string{"low", "medium", "ultra"}

	if !statusChanged(previous, next) {
		t.Fatal("statusChanged() = false, want true for model effort changes")
	}
}
