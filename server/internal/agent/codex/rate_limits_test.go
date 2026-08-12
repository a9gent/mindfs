package codex

import (
	"encoding/json"
	"testing"
)

func TestRateLimitResponseDecodesAppServerCamelCase(t *testing.T) {
	const payload = `{"rateLimits":{"primary":{"usedPercent":33,"windowDurationMins":10080,"resetsAt":1787014822}},"rateLimitResetCredits":{"availableCount":1}}`
	var response rawRateLimitResponse
	if err := json.Unmarshal([]byte(payload), &response); err != nil {
		t.Fatal(err)
	}
	status := normalizeRateLimitStatus(response)
	if status.Weekly == nil || status.Weekly.UsedPercent != 33 {
		t.Fatalf("expected decoded weekly window, got %#v", status.Weekly)
	}
	if status.ResetCredits == nil || status.ResetCredits.AvailableCount != 1 {
		t.Fatalf("expected decoded reset count, got %#v", status.ResetCredits)
	}
}

func TestNormalizeRateLimitStatusSelectsWeeklyWindowByDuration(t *testing.T) {
	fiveHours := int64(300)
	weekly := int64(10080)
	resetsAt := int64(1787014822)
	response := rawRateLimitResponse{
		RateLimitsByLimitID: map[string]rawRateLimitSnapshot{
			"codex": {
				Primary:   &rawRateLimitWindow{UsedPercent: 22, WindowDurationMins: &weekly, ResetsAt: &resetsAt},
				Secondary: &rawRateLimitWindow{UsedPercent: 5, WindowDurationMins: &fiveHours},
			},
		},
	}
	response.ResetCredits = &struct {
		AvailableCount int64                     `json:"availableCount"`
		Credits        []rawRateLimitResetCredit `json:"credits"`
	}{
		AvailableCount: 1,
		Credits: []rawRateLimitResetCredit{{
			ID:        "credit-1",
			Status:    "available",
			ExpiresAt: &resetsAt,
		}},
	}

	status := normalizeRateLimitStatus(response)
	if status.Weekly == nil || status.Weekly.UsedPercent != 22 {
		t.Fatalf("expected primary weekly window, got %#v", status.Weekly)
	}
	if status.ResetCredits == nil || status.ResetCredits.AvailableCount != 1 {
		t.Fatalf("expected one reset credit, got %#v", status.ResetCredits)
	}
	if len(status.ResetCredits.Credits) != 1 || status.ResetCredits.Credits[0].ID != "credit-1" {
		t.Fatalf("expected reset credit details, got %#v", status.ResetCredits.Credits)
	}
}

func TestNormalizeRateLimitStatusFallsBackToLegacySecondary(t *testing.T) {
	response := rawRateLimitResponse{
		RateLimits: rawRateLimitSnapshot{
			Primary:   &rawRateLimitWindow{UsedPercent: 10},
			Secondary: &rawRateLimitWindow{UsedPercent: 45},
		},
	}
	status := normalizeRateLimitStatus(response)
	if status.Weekly == nil || status.Weekly.UsedPercent != 45 {
		t.Fatalf("expected legacy secondary weekly window, got %#v", status.Weekly)
	}
}

func TestNormalizeRateLimitStatusClampsNegativeResetCount(t *testing.T) {
	response := rawRateLimitResponse{}
	response.ResetCredits = &struct {
		AvailableCount int64                     `json:"availableCount"`
		Credits        []rawRateLimitResetCredit `json:"credits"`
	}{AvailableCount: -1}
	status := normalizeRateLimitStatus(response)
	if status.ResetCredits == nil || status.ResetCredits.AvailableCount != 0 {
		t.Fatalf("expected reset count 0, got %#v", status.ResetCredits)
	}
}

func TestUsesChatGPTPlanRequiresOfficialProviderAndChatGPTAccount(t *testing.T) {
	chatGPTAccount := func(accountType string, requiresOpenAIAuth bool) rawAccountResponse {
		response := rawAccountResponse{RequiresOpenAIAuth: requiresOpenAIAuth}
		response.Account = &struct {
			Type string `json:"type"`
		}{Type: accountType}
		return response
	}

	tests := []struct {
		name     string
		response rawAccountResponse
		want     bool
	}{
		{name: "official ChatGPT plan", response: chatGPTAccount("chatgpt", true), want: true},
		{name: "API key account", response: chatGPTAccount("apiKey", true), want: false},
		{name: "custom provider with cached ChatGPT login", response: chatGPTAccount("chatgpt", false), want: false},
		{name: "no account", response: rawAccountResponse{RequiresOpenAIAuth: true}, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := usesChatGPTPlan(test.response); got != test.want {
				t.Fatalf("usesChatGPTPlan() = %t, want %t", got, test.want)
			}
		})
	}
}
