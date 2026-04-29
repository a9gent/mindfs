// Error handling service for MindFS

export type ErrorCode =
  // Session errors
  | "session.not_found"
  | "session.create_failed"
  | "session.closed"
  | "session.resume_failed"
  | "session.delete_failed"
  | "session.import_failed"
  | "session.rename_failed"
  | "session.sync_failed"
  | "app.init_failed"
  // Root/project errors
  | "root.create_failed"
  | "root.delete_failed"
  // Agent errors
  | "agent.unavailable"
  | "agent.timeout"
  | "agent.crashed"
  | "agent.permission_denied"
  // View errors
  | "view.invalid"
  | "view.render_failed"
  // File errors
  | "file.not_found"
  | "file.read_failed"
  | "file.write_failed"
  // Skill errors
  | "skill.not_found"
  | "skill.execute_failed"
  // Network errors
  | "network.disconnected"
  | "network.timeout";

export type ErrorSeverity = "info" | "warning" | "error" | "fatal";

export type AppError = {
  code: ErrorCode;
  message: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  retryAction?: () => Promise<void>;
  details?: Record<string, unknown>;
};

type ErrorListener = (error: AppError) => void;

class ErrorService {
  private listeners: Set<ErrorListener> = new Set();

  // Subscribe to errors
  subscribe(listener: ErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Report an error
  report(error: AppError): void {
    // Log to console
    const logMethod =
      error.severity === "fatal" || error.severity === "error"
        ? console.error
        : error.severity === "warning"
        ? console.warn
        : console.info;

    logMethod(`[${error.code}] ${error.message}`, error.details);

    // Notify listeners
    this.listeners.forEach((listener) => {
      try {
        listener(error);
      } catch (e) {
        console.error("Error in error listener:", e);
      }
    });
  }

  // Create error from code
  fromCode(
    code: ErrorCode,
    message?: string,
    options?: Partial<Omit<AppError, "code" | "message">>
  ): AppError {
    const defaults = this.getDefaults(code);
    return {
      code,
      message: message || defaults.message,
      severity: options?.severity || defaults.severity,
      recoverable: options?.recoverable ?? defaults.recoverable,
      retryAction: options?.retryAction,
      details: options?.details,
    };
  }

  // Get default error properties by code
  private getDefaults(code: ErrorCode): {
    message: string;
    severity: ErrorSeverity;
    recoverable: boolean;
  } {
    const defaults: Record<
      ErrorCode,
      { message: string; severity: ErrorSeverity; recoverable: boolean }
    > = {
      "session.not_found": {
        message: "会话不存在",
        severity: "error",
        recoverable: false,
      },
      "session.create_failed": {
        message: "创建会话失败",
        severity: "error",
        recoverable: true,
      },
      "session.closed": {
        message: "会话已关闭",
        severity: "warning",
        recoverable: true,
      },
      "session.resume_failed": {
        message: "恢复会话失败",
        severity: "error",
        recoverable: true,
      },
      "session.delete_failed": {
        message: "删除会话失败",
        severity: "error",
        recoverable: true,
      },
      "session.import_failed": {
        message: "导入会话失败",
        severity: "error",
        recoverable: true,
      },
      "session.rename_failed": {
        message: "重命名会话失败",
        severity: "error",
        recoverable: true,
      },
      "session.sync_failed": {
        message: "同步会话失败",
        severity: "error",
        recoverable: true,
      },
      "app.init_failed": {
        message: "初始化失败",
        severity: "error",
        recoverable: true,
      },
      "root.create_failed": {
        message: "创建项目失败",
        severity: "error",
        recoverable: true,
      },
      "root.delete_failed": {
        message: "删除项目失败",
        severity: "error",
        recoverable: true,
      },
      "agent.unavailable": {
        message: "Agent 不可用",
        severity: "error",
        recoverable: true,
      },
      "agent.timeout": {
        message: "Agent 响应超时",
        severity: "warning",
        recoverable: true,
      },
      "agent.crashed": {
        message: "Agent 进程崩溃",
        severity: "error",
        recoverable: true,
      },
      "agent.permission_denied": {
        message: "权限被拒绝",
        severity: "warning",
        recoverable: false,
      },
      "view.invalid": {
        message: "视图格式无效",
        severity: "error",
        recoverable: false,
      },
      "view.render_failed": {
        message: "视图渲染失败",
        severity: "error",
        recoverable: true,
      },
      "file.not_found": {
        message: "文件不存在",
        severity: "error",
        recoverable: false,
      },
      "file.read_failed": {
        message: "读取文件失败",
        severity: "error",
        recoverable: true,
      },
      "file.write_failed": {
        message: "写入文件失败",
        severity: "error",
        recoverable: true,
      },
      "skill.not_found": {
        message: "技能不存在",
        severity: "error",
        recoverable: false,
      },
      "skill.execute_failed": {
        message: "技能执行失败",
        severity: "error",
        recoverable: true,
      },
      "network.disconnected": {
        message: "网络连接断开",
        severity: "warning",
        recoverable: true,
      },
      "network.timeout": {
        message: "网络请求超时",
        severity: "warning",
        recoverable: true,
      },
    };

    return defaults[code];
  }
}

export const errorService = new ErrorService();

// Helper to create and report error
export function reportError(
  code: ErrorCode,
  message?: string,
  options?: Partial<Omit<AppError, "code" | "message">>
): void {
  const error = errorService.fromCode(code, message, options);
  errorService.report(error);
}
