package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"mindfs/server/app"
)

var version = "dev"

func main() {
	addr := flag.String("addr", "127.0.0.1:7331", "listen address")
	noRelayer := flag.Bool("no-relayer", false, "disable relay integration")
	webPushFlag := flag.Bool("web-push", true, "enable PWA Web Push notifications")
	configFlag := flag.String("config", "", "mindfs startup config file; command-line flags override file values")
	agentConfigFlag := flag.String("agent-config", "", "extra agents.json file")
	notifyScriptFlag := flag.String("notify-script", "", "executable script for notification events; receives JSON payload on stdin")
	feishuWebhookFlag := flag.String("feishu-webhook", "", "Feishu/Lark bot webhook URL for outbound notifications")
	feishuAppIDFlag := flag.String("feishu-app-id", "", "Feishu app id for outbound IM notifications")
	feishuAppSecretFlag := flag.String("feishu-app-secret", "", "Feishu app secret for outbound IM notifications")
	feishuChatIDFlag := flag.String("feishu-chat-id", "", "Feishu chat id (receive_id) for outbound IM notifications")
	flag.Parse()
	explicitFlags := visitedFlags(flag.CommandLine)
	startupCfg, err := loadStartupConfig(*configFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	applyStartupConfig(startupCfg, explicitFlags, addr, noRelayer, webPushFlag, agentConfigFlag, notifyScriptFlag, feishuWebhookFlag, feishuAppIDFlag, feishuAppSecretFlag, feishuChatIDFlag)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := app.Start(ctx, *addr, app.StartOptions{
		NoRelayer:       *noRelayer,
		Version:         version,
		Args:            os.Args[1:],
		AgentConfigPath: *agentConfigFlag,
		WebPushEnabled:  *webPushFlag,
		NotifyScript:    *notifyScriptFlag,
		FeishuWebhook:   *feishuWebhookFlag,
		FeishuAppID:     *feishuAppIDFlag,
		FeishuAppSecret: *feishuAppSecretFlag,
		FeishuChatID:    *feishuChatIDFlag,
	}); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

type startupConfig struct {
	Addr          *string `json:"addr"`
	NoRelayer     *bool   `json:"noRelayer"`
	NoRelayerFlag *bool   `json:"no-relayer"`
	WebPush       *bool   `json:"webPush"`
	WebPushFlag   *bool   `json:"web-push"`
	AgentConfig   *string `json:"agent-config"`
	NotifyScript    *string `json:"notify-script"`
	FeishuWebhook   *string `json:"feishu-webhook"`
	FeishuAppID     *string `json:"feishu-app-id"`
	FeishuAppSecret *string `json:"feishu-app-secret"`
	FeishuChatID    *string `json:"feishu-chat-id"`
}

func loadStartupConfig(path string) (startupConfig, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return startupConfig{}, nil
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return startupConfig{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg startupConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return startupConfig{}, fmt.Errorf("decode config %s: %w", path, err)
	}
	return cfg, nil
}

func visitedFlags(flags *flag.FlagSet) map[string]bool {
	visited := make(map[string]bool)
	flags.Visit(func(f *flag.Flag) {
		visited[f.Name] = true
	})
	return visited
}

func applyStartupConfig(cfg startupConfig, explicit map[string]bool, addr *string, noRelayer *bool, webPush *bool, agentConfig *string, notifyScript *string, feishuWebhook *string, feishuAppID *string, feishuAppSecret *string, feishuChatID *string) {
	if cfg.Addr != nil && !explicit["addr"] {
		*addr = strings.TrimSpace(*cfg.Addr)
	}
	if value := firstBool(cfg.NoRelayer, cfg.NoRelayerFlag); value != nil && !explicit["no-relayer"] {
		*noRelayer = *value
	}
	if value := firstBool(cfg.WebPush, cfg.WebPushFlag); value != nil && !explicit["web-push"] {
		*webPush = *value
	}
	if cfg.AgentConfig != nil && !explicit["agent-config"] {
		*agentConfig = strings.TrimSpace(*cfg.AgentConfig)
	}
	if cfg.NotifyScript != nil && !explicit["notify-script"] {
		*notifyScript = strings.TrimSpace(*cfg.NotifyScript)
	}
	if cfg.FeishuWebhook != nil && !explicit["feishu-webhook"] {
		*feishuWebhook = strings.TrimSpace(*cfg.FeishuWebhook)
	}
	if cfg.FeishuAppID != nil && !explicit["feishu-app-id"] {
		*feishuAppID = strings.TrimSpace(*cfg.FeishuAppID)
	}
	if cfg.FeishuAppSecret != nil && !explicit["feishu-app-secret"] {
		*feishuAppSecret = strings.TrimSpace(*cfg.FeishuAppSecret)
	}
	if cfg.FeishuChatID != nil && !explicit["feishu-chat-id"] {
		*feishuChatID = strings.TrimSpace(*cfg.FeishuChatID)
	}
}

func firstBool(values ...*bool) *bool {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
