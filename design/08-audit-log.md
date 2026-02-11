# 审计日志

对应代码：`server/internal/audit/`

---

## history.jsonl 记录内容

```jsonl
{"ts":1706698800,"type":"session","action":"create","session":"session-001","session_type":"skill","actor":"user"}
{"ts":1706698801,"type":"session","action":"message","session":"session-001","role":"user","content_hash":"abc123","actor":"user"}
{"ts":1706698805,"type":"file","action":"create","path":"novels/erta/ch1.txt","session":"session-001","actor":"agent","size":12000}
{"ts":1706698810,"type":"view","action":"generate","rule":"novels-reader","version":"v1","session":"session-001","actor":"agent"}
{"ts":1706698900,"type":"session","action":"close","session":"session-001","actor":"system"}
{"ts":1706699000,"type":"file","action":"open","path":"novels/erta/ch1.txt","actor":"user"}
{"ts":1706699100,"type":"view","action":"switch","rule":"novels-reader","from":"v1","to":"v2","actor":"user"}
```

---

## 操作类型

| 类型 | 操作 | 说明 |
|-----|------|------|
| **session** | create, message, close, resume | Session 生命周期 |
| **file** | open, create, delete, rename | 文件操作 |
| **view** | generate, switch, revert | 视图操作 |
| **skill** | execute, cancel | 技能执行 |
| **dir** | add, remove | 管理目录 |
