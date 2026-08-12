package codex

import (
	"context"
	"errors"
	"fmt"
	"strings"

	codexsdk "github.com/fanwenlin/codex-go-sdk/codex"
)

const weeklyWindowMinutes = int64(7 * 24 * 60)

type RateLimitWindow struct {
	UsedPercent        int32  `json:"used_percent"`
	WindowDurationMins *int64 `json:"window_duration_mins,omitempty"`
	ResetsAt           *int64 `json:"resets_at,omitempty"`
}

type RateLimitResetCredit struct {
	ID          string `json:"id"`
	ResetType   string `json:"reset_type,omitempty"`
	Status      string `json:"status,omitempty"`
	GrantedAt   int64  `json:"granted_at,omitempty"`
	ExpiresAt   *int64 `json:"expires_at,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
}

type RateLimitResetCredits struct {
	AvailableCount int64                  `json:"available_count"`
	Credits        []RateLimitResetCredit `json:"credits,omitempty"`
}

type RateLimitStatus struct {
	UsesChatGPTPlan bool                   `json:"uses_chatgpt_plan"`
	Weekly          *RateLimitWindow       `json:"weekly,omitempty"`
	ResetCredits    *RateLimitResetCredits `json:"reset_credits,omitempty"`
}

type ConsumeRateLimitResetResult struct {
	Outcome string          `json:"outcome"`
	Status  RateLimitStatus `json:"status"`
}

type rawRateLimitSnapshot struct {
	LimitID   *string             `json:"limitId"`
	Primary   *rawRateLimitWindow `json:"primary"`
	Secondary *rawRateLimitWindow `json:"secondary"`
}

type rawRateLimitWindow struct {
	UsedPercent        int32  `json:"usedPercent"`
	WindowDurationMins *int64 `json:"windowDurationMins"`
	ResetsAt           *int64 `json:"resetsAt"`
}

type rawRateLimitResponse struct {
	RateLimits          rawRateLimitSnapshot            `json:"rateLimits"`
	RateLimitsByLimitID map[string]rawRateLimitSnapshot `json:"rateLimitsByLimitId"`
	ResetCredits        *struct {
		AvailableCount int64                     `json:"availableCount"`
		Credits        []rawRateLimitResetCredit `json:"credits"`
	} `json:"rateLimitResetCredits"`
}

type rawAccountResponse struct {
	Account *struct {
		Type string `json:"type"`
	} `json:"account"`
	RequiresOpenAIAuth bool `json:"requiresOpenaiAuth"`
}

type rawRateLimitResetCredit struct {
	ID          string `json:"id"`
	ResetType   string `json:"resetType"`
	Status      string `json:"status"`
	GrantedAt   int64  `json:"grantedAt"`
	ExpiresAt   *int64 `json:"expiresAt"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type rawConsumeRateLimitResetResponse struct {
	Outcome string `json:"outcome"`
}

func (r *Runtime) ReadRateLimits(ctx context.Context, opts OpenOptions) (RateLimitStatus, error) {
	if r == nil {
		return RateLimitStatus{}, errors.New("codex runtime not initialized")
	}
	return readRateLimits(ctx, r.getOrCreateClient(opts))
}

func (r *Runtime) ConsumeRateLimitReset(ctx context.Context, opts OpenOptions, idempotencyKey, creditID string) (ConsumeRateLimitResetResult, error) {
	if r == nil {
		return ConsumeRateLimitResetResult{}, errors.New("codex runtime not initialized")
	}
	return consumeRateLimitReset(ctx, r.getOrCreateClient(opts), idempotencyKey, creditID)
}

func (s *session) ReadRateLimits(ctx context.Context) (RateLimitStatus, error) {
	if s == nil || s.client == nil {
		return RateLimitStatus{}, errors.New("codex session not initialized")
	}
	return readRateLimits(ctx, s.client)
}

func readRateLimits(ctx context.Context, client *codexsdk.Codex) (RateLimitStatus, error) {
	if client == nil {
		return RateLimitStatus{}, errors.New("codex client not initialized")
	}
	usesChatGPTPlan, err := readUsesChatGPTPlan(ctx, client)
	if err != nil {
		return RateLimitStatus{}, err
	}
	if !usesChatGPTPlan {
		return RateLimitStatus{}, nil
	}
	var response rawRateLimitResponse
	if err := client.AppServerRPCTyped(ctx, "account/rateLimits/read", nil, &response); err != nil {
		return RateLimitStatus{}, err
	}
	status := normalizeRateLimitStatus(response)
	status.UsesChatGPTPlan = true
	return status, nil
}

func readUsesChatGPTPlan(ctx context.Context, client *codexsdk.Codex) (bool, error) {
	var response rawAccountResponse
	if err := client.AppServerRPCTyped(ctx, "account/read", map[string]any{"refreshToken": false}, &response); err != nil {
		return false, err
	}
	return usesChatGPTPlan(response), nil
}

func usesChatGPTPlan(response rawAccountResponse) bool {
	return response.RequiresOpenAIAuth && response.Account != nil && strings.EqualFold(strings.TrimSpace(response.Account.Type), "chatgpt")
}

func consumeRateLimitReset(ctx context.Context, client *codexsdk.Codex, idempotencyKey, creditID string) (ConsumeRateLimitResetResult, error) {
	if client == nil {
		return ConsumeRateLimitResetResult{}, errors.New("codex client not initialized")
	}
	eligible, err := readUsesChatGPTPlan(ctx, client)
	if err != nil {
		return ConsumeRateLimitResetResult{}, err
	}
	if !eligible {
		return ConsumeRateLimitResetResult{}, errors.New("ChatGPT plan authentication required for rate limit reset")
	}
	idempotencyKey = strings.TrimSpace(idempotencyKey)
	if idempotencyKey == "" {
		return ConsumeRateLimitResetResult{}, errors.New("idempotency key required")
	}
	params := map[string]any{"idempotencyKey": idempotencyKey}
	if creditID = strings.TrimSpace(creditID); creditID != "" {
		params["creditId"] = creditID
	}
	var response rawConsumeRateLimitResetResponse
	if err := client.AppServerRPCTyped(ctx, "account/rateLimitResetCredit/consume", params, &response); err != nil {
		return ConsumeRateLimitResetResult{}, err
	}
	status, err := readRateLimits(ctx, client)
	if err != nil {
		return ConsumeRateLimitResetResult{}, fmt.Errorf("refresh rate limits after %s: %w", response.Outcome, err)
	}
	return ConsumeRateLimitResetResult{Outcome: response.Outcome, Status: status}, nil
}

func normalizeRateLimitStatus(response rawRateLimitResponse) RateLimitStatus {
	snapshot := response.RateLimits
	if codexSnapshot, ok := response.RateLimitsByLimitID["codex"]; ok {
		snapshot = codexSnapshot
	}
	status := RateLimitStatus{Weekly: selectWeeklyWindow(snapshot)}
	if response.ResetCredits != nil {
		credits := make([]RateLimitResetCredit, 0, len(response.ResetCredits.Credits))
		for _, credit := range response.ResetCredits.Credits {
			credits = append(credits, RateLimitResetCredit{
				ID:          credit.ID,
				ResetType:   credit.ResetType,
				Status:      credit.Status,
				GrantedAt:   credit.GrantedAt,
				ExpiresAt:   credit.ExpiresAt,
				Title:       credit.Title,
				Description: credit.Description,
			})
		}
		status.ResetCredits = &RateLimitResetCredits{
			AvailableCount: maxInt64(response.ResetCredits.AvailableCount, 0),
			Credits:        credits,
		}
	}
	return status
}

func selectWeeklyWindow(snapshot rawRateLimitSnapshot) *RateLimitWindow {
	for _, window := range []*rawRateLimitWindow{snapshot.Primary, snapshot.Secondary} {
		if window == nil || window.WindowDurationMins == nil {
			continue
		}
		if duration := *window.WindowDurationMins; duration >= weeklyWindowMinutes-3 && duration <= weeklyWindowMinutes+3 {
			return cloneRateLimitWindow(window)
		}
	}
	// Older app-server responses conventionally placed the weekly window in secondary.
	if snapshot.Secondary != nil {
		return cloneRateLimitWindow(snapshot.Secondary)
	}
	return nil
}

func cloneRateLimitWindow(window *rawRateLimitWindow) *RateLimitWindow {
	if window == nil {
		return nil
	}
	return &RateLimitWindow{
		UsedPercent:        window.UsedPercent,
		WindowDurationMins: window.WindowDurationMins,
		ResetsAt:           window.ResetsAt,
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
