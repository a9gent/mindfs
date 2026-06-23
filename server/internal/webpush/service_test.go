package webpush

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildSessionPayloadMatchesNativeReplyShape(t *testing.T) {
	payload := BuildSessionPayload(SessionNotification{
		Type:         "session.done",
		RootID:       "root-1",
		RootTitle:    "MindFS Repo",
		SessionKey:   "sess-1",
		SessionTitle: "实现通知",
		Summary:      "已经完成 Web Push 接入",
		EventID:      "event-1",
	})

	if payload.Title != "MindFS Repo · 实现通知 · 完成" {
		t.Fatalf("title = %q", payload.Title)
	}
	if payload.Body != "已经完成 Web Push 接入" {
		t.Fatalf("body = %q", payload.Body)
	}
	if payload.URL != "./?root=root-1&session=sess-1" {
		t.Fatalf("url = %q", payload.URL)
	}
	if !strings.Contains(payload.Tag, "event-1") {
		t.Fatalf("done tag should include event id, got %q", payload.Tag)
	}
	if payload.RequireInteraction {
		t.Fatal("done notification should not require interaction")
	}
	if !payload.Renotify {
		t.Fatal("done notification should renotify repeated completions in the same session")
	}
}

func TestBuildAskUserPayloadRequiresInteraction(t *testing.T) {
	payload := BuildSessionPayload(SessionNotification{
		Type:         "session.ask_user",
		RootID:       "root 1",
		SessionKey:   "sess&1",
		SessionTitle: "计划",
		Summary:      "请选择实现方式",
	})

	if payload.Title != "root 1 · 计划 · 需要输入" {
		t.Fatalf("title = %q", payload.Title)
	}
	if !payload.RequireInteraction || !payload.Renotify {
		t.Fatalf("ask user payload should require interaction and renotify: %#v", payload)
	}
	if payload.URL != "./?root=root+1&session=sess%261" {
		t.Fatalf("url = %q", payload.URL)
	}
}

func TestBuildScheduledPayload(t *testing.T) {
	done := BuildScheduledPayload(ScheduledNotification{
		RootTitle:  "MindFS",
		TaskID:     "task-1",
		TaskName:   "每日总结",
		SessionKey: "sess-1",
		Summary:    "运行完成",
		Success:    true,
	})
	if done.Title != "MindFS · 定时任务完成" || done.Body != "每日总结: 运行完成" {
		t.Fatalf("done payload = %#v", done)
	}

	failed := BuildScheduledPayload(ScheduledNotification{
		RootTitle: "MindFS",
		TaskID:    "task-1",
		TaskName:  "每日总结",
		Error:     "agent unavailable",
		Success:   false,
	})
	if failed.Title != "MindFS · 定时任务失败" || failed.Body != "每日总结: agent unavailable" {
		t.Fatalf("failed payload = %#v", failed)
	}
	if !failed.RequireInteraction || !failed.Renotify {
		t.Fatalf("failed payload should require attention: %#v", failed)
	}
}

func TestTestPayloadDoesNotUseFixedNotificationTag(t *testing.T) {
	payload := testPayload()
	if payload.Type != "test" || payload.Title != "MindFS" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.Tag != "" {
		t.Fatalf("test payload should not use a fixed tag, got %q", payload.Tag)
	}
	if payload.Data["eventId"] == "" {
		t.Fatalf("test payload should include eventId: %#v", payload.Data)
	}
}

func TestStoreUpsertAndDelete(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), "subscriptions.json")}
	sub, err := store.Upsert(Subscription{
		Endpoint: "https://push.example/sub-1",
		Keys: SubscriptionKeys{
			Auth:   "auth",
			P256dh: "p256dh",
		},
		UserAgent: "test-agent",
		Platform:  "ios-pwa",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if sub.ID == "" || !sub.Enabled {
		t.Fatalf("subscription not normalized: %#v", sub)
	}

	updated, err := store.Upsert(Subscription{
		Endpoint: "https://push.example/sub-1",
		Keys: SubscriptionKeys{
			Auth:   "auth2",
			P256dh: "p256dh2",
		},
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.ID != sub.ID || updated.Keys.Auth != "auth2" {
		t.Fatalf("updated = %#v, original = %#v", updated, sub)
	}

	items, err := store.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d", len(items))
	}
	if !strings.Contains(items[0].Endpoint, "sub-1") {
		t.Fatalf("endpoint = %q", items[0].Endpoint)
	}

	if err := store.Delete("https://push.example/sub-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	items, err = store.List()
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("items after delete = %#v", items)
	}
}

func TestStoreGetByEndpoint(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), "subscriptions.json")}
	if _, ok, err := store.GetByEndpoint("https://push.example/sub-1"); err != nil || ok {
		t.Fatalf("empty GetByEndpoint ok=%v err=%v", ok, err)
	}
	created, err := store.Upsert(Subscription{
		Endpoint: "https://push.example/sub-1",
		Keys: SubscriptionKeys{
			Auth:   "auth",
			P256dh: "p256dh",
		},
		Platform: "desktop-pwa",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	found, ok, err := store.GetByEndpoint("https://push.example/sub-1")
	if err != nil {
		t.Fatalf("GetByEndpoint: %v", err)
	}
	if !ok || found.ID != created.ID || found.Platform != "desktop-pwa" {
		t.Fatalf("found=%#v ok=%v created=%#v", found, ok, created)
	}
}

func TestSendTestFailsWithoutSubscriptions(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), "subscriptions.json")}
	service := NewService(Config{
		Enabled:    true,
		PublicKey:  "public",
		PrivateKey: "private",
		Subject:    defaultVAPIDSubject,
	}, store)

	err := service.SendTest(t.Context())
	if err == nil || !strings.Contains(err.Error(), "no web push subscriptions") {
		t.Fatalf("SendTest error = %v", err)
	}
}

func TestSendTestToEndpointRequiresRegisteredSubscription(t *testing.T) {
	store := &Store{path: filepath.Join(t.TempDir(), "subscriptions.json")}
	service := NewService(Config{
		Enabled:    true,
		PublicKey:  "public",
		PrivateKey: "private",
		Subject:    defaultVAPIDSubject,
	}, store)

	err := service.SendTestToEndpoint(t.Context(), "https://push.example/missing")
	if err == nil || !strings.Contains(err.Error(), "not registered") {
		t.Fatalf("SendTestToEndpoint error = %v", err)
	}
}

func TestEnsureConfigAutoGeneratesVAPIDKeys(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("HOME", configRoot)

	first, err := EnsureConfig(true)
	if err != nil {
		t.Fatalf("first EnsureConfig: %v", err)
	}
	if !first.Enabled || first.PublicKey == "" || first.PrivateKey == "" {
		t.Fatalf("first config not enabled/generated: %#v", first)
	}

	second, err := EnsureConfig(true)
	if err != nil {
		t.Fatalf("second EnsureConfig: %v", err)
	}
	if second.PublicKey != first.PublicKey || second.PrivateKey != first.PrivateKey {
		t.Fatalf("keys were not persisted: first=%#v second=%#v", first, second)
	}
}

func TestEnsureConfigCanDisableWebPush(t *testing.T) {
	cfg, err := EnsureConfig(false)
	if err != nil {
		t.Fatalf("EnsureConfig: %v", err)
	}
	if cfg.Enabled {
		t.Fatalf("cfg.Enabled = true, want false")
	}
}
