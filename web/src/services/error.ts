// Error handling service for MindFS
import { translateNow, type MessageKey } from "../i18n";

export type ErrorCode =
  // Session errors
  | "session.not_found"
  | "session.create_failed"
  | "session.closed"
  | "session.resume_failed"
  | "session.delete_failed"
  | "session.import_failed"
  | "session.rename_failed"
  | "session.pin_failed"
  | "session.sync_failed"
  | "session.slash_command_failed"
  | "app.init_failed"
  // Root/project errors
  | "root.create_failed"
  | "root.delete_failed"
  | "root.rename_failed"
  | "git.checkout_failed"
  | "git.related_file_diff_failed"
  | "git.worktree_switch_failed"
  | "git.worktree_remove_failed"
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
  // Clipboard errors
  | "clipboard.write_failed"
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
  messageKey?: MessageKey;
  usesDefaultMessage?: boolean;
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
    const usesDefaultMessage = !message;
    return {
      code,
      message: message || defaults.message,
      messageKey: defaults.messageKey,
      usesDefaultMessage,
      severity: options?.severity || defaults.severity,
      recoverable: options?.recoverable ?? defaults.recoverable,
      retryAction: options?.retryAction,
      details: options?.details,
    };
  }

  // Get default error properties by code
  private getDefaults(code: ErrorCode): {
    message: string;
    messageKey: MessageKey;
    severity: ErrorSeverity;
    recoverable: boolean;
  } {
    const defaults: Record<
      ErrorCode,
      { messageKey: MessageKey; severity: ErrorSeverity; recoverable: boolean }
    > = {
      "session.not_found": {
        messageKey: "error.session.notFound",
        severity: "error",
        recoverable: false,
      },
      "session.create_failed": {
        messageKey: "error.session.createFailed",
        severity: "error",
        recoverable: true,
      },
      "session.closed": {
        messageKey: "error.session.closed",
        severity: "warning",
        recoverable: true,
      },
      "session.resume_failed": {
        messageKey: "error.session.resumeFailed",
        severity: "error",
        recoverable: true,
      },
      "session.delete_failed": {
        messageKey: "error.session.deleteFailed",
        severity: "error",
        recoverable: true,
      },
      "session.import_failed": {
        messageKey: "error.session.importFailed",
        severity: "error",
        recoverable: true,
      },
      "session.rename_failed": {
        messageKey: "error.session.renameFailed",
        severity: "error",
        recoverable: true,
      },
      "session.pin_failed": {
        messageKey: "error.session.pinFailed",
        severity: "error",
        recoverable: true,
      },
      "session.sync_failed": {
        messageKey: "error.session.syncFailed",
        severity: "error",
        recoverable: true,
      },
      "session.slash_command_failed": {
        messageKey: "error.session.slashCommandFailed",
        severity: "error",
        recoverable: true,
      },
      "app.init_failed": {
        messageKey: "error.app.initFailed",
        severity: "error",
        recoverable: true,
      },
      "root.create_failed": {
        messageKey: "error.root.createFailed",
        severity: "error",
        recoverable: true,
      },
      "root.delete_failed": {
        messageKey: "error.root.deleteFailed",
        severity: "error",
        recoverable: true,
      },
      "root.rename_failed": {
        messageKey: "error.root.renameFailed",
        severity: "error",
        recoverable: true,
      },
      "git.checkout_failed": {
        messageKey: "error.git.checkoutFailed",
        severity: "error",
        recoverable: true,
      },
      "git.related_file_diff_failed": {
        messageKey: "error.git.relatedFileDiffFailed",
        severity: "warning",
        recoverable: true,
      },
      "git.worktree_switch_failed": {
        messageKey: "error.git.worktreeSwitchFailed",
        severity: "error",
        recoverable: true,
      },
      "git.worktree_remove_failed": {
        messageKey: "error.git.worktreeRemoveFailed",
        severity: "error",
        recoverable: true,
      },
      "agent.unavailable": {
        messageKey: "error.agent.unavailable",
        severity: "error",
        recoverable: true,
      },
      "agent.timeout": {
        messageKey: "error.agent.timeout",
        severity: "warning",
        recoverable: true,
      },
      "agent.crashed": {
        messageKey: "error.agent.crashed",
        severity: "error",
        recoverable: true,
      },
      "agent.permission_denied": {
        messageKey: "error.agent.permissionDenied",
        severity: "warning",
        recoverable: false,
      },
      "view.invalid": {
        messageKey: "error.view.invalid",
        severity: "error",
        recoverable: false,
      },
      "view.render_failed": {
        messageKey: "error.view.renderFailed",
        severity: "error",
        recoverable: true,
      },
      "file.not_found": {
        messageKey: "error.file.notFound",
        severity: "error",
        recoverable: false,
      },
      "file.read_failed": {
        messageKey: "error.file.readFailed",
        severity: "error",
        recoverable: true,
      },
      "file.write_failed": {
        messageKey: "error.file.writeFailed",
        severity: "error",
        recoverable: true,
      },
      "clipboard.write_failed": {
        messageKey: "error.clipboard.writeFailed",
        severity: "warning",
        recoverable: true,
      },
      "skill.not_found": {
        messageKey: "error.skill.notFound",
        severity: "error",
        recoverable: false,
      },
      "skill.execute_failed": {
        messageKey: "error.skill.executeFailed",
        severity: "error",
        recoverable: true,
      },
      "network.disconnected": {
        messageKey: "error.network.disconnected",
        severity: "warning",
        recoverable: true,
      },
      "network.timeout": {
        messageKey: "error.network.timeout",
        severity: "warning",
        recoverable: true,
      },
    };

    const defaultsForCode = defaults[code];
    return {
      ...defaultsForCode,
      message: translateNow(defaultsForCode.messageKey),
    };
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
