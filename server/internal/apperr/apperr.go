package apperr

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

const (
	CodePermissionDenied = "file_permission_denied"
	CodeNotFound         = "file_not_found"
	CodeAlreadyExists    = "file_already_exists"
	CodeInvalidPath      = "file_invalid_path"
	CodeIO               = "file_io_error"
)

type Error struct {
	Code      string `json:"code"`
	Op        string `json:"operation,omitempty"`
	Path      string `json:"path,omitempty"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Temporary bool   `json:"temporary,omitempty"`
	Err       error  `json:"-"`
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func Wrap(op, path string, err error) error {
	if err == nil {
		return nil
	}
	var existing *Error
	if errors.As(err, &existing) {
		return err
	}
	code := classify(err)
	if code == "" {
		code = CodeIO
	}
	return &Error{
		Code:    code,
		Op:      strings.TrimSpace(op),
		Path:    strings.TrimSpace(path),
		Message: buildMessage(code, op, path),
		Detail:  strings.TrimSpace(err.Error()),
		Err:     err,
	}
}

func Wrapf(op, path string, err error, format string, args ...any) error {
	if err == nil {
		return nil
	}
	wrapped := Wrap(op, path, err)
	var appErr *Error
	if errors.As(wrapped, &appErr) {
		appErr.Message = fmt.Sprintf(format, args...)
	}
	return wrapped
}

func Classify(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var appErr *Error
	if errors.As(err, &appErr) {
		return appErr, true
	}
	code := classify(err)
	if code == "" {
		return nil, false
	}
	return &Error{
		Code:    code,
		Message: buildMessage(code, "", ""),
		Detail:  strings.TrimSpace(err.Error()),
		Err:     err,
	}, true
}

func IsPermission(err error) bool {
	return classify(err) == CodePermissionDenied
}

func classify(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, os.ErrPermission):
		return CodePermissionDenied
	case errors.Is(err, os.ErrNotExist):
		return CodeNotFound
	case errors.Is(err, os.ErrExist):
		return CodeAlreadyExists
	case errors.Is(err, os.ErrInvalid):
		return CodeInvalidPath
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	switch {
	case strings.Contains(msg, "access is denied"),
		strings.Contains(msg, "permission denied"),
		strings.Contains(msg, "operation not permitted"),
		strings.Contains(msg, "unauthorizedaccess"),
		strings.Contains(msg, "eacces"),
		strings.Contains(msg, "eperm"):
		return CodePermissionDenied
	case strings.Contains(msg, "cannot find the path specified"),
		strings.Contains(msg, "no such file or directory"),
		strings.Contains(msg, "file not found"),
		strings.Contains(msg, "path not found"):
		return CodeNotFound
	default:
		return ""
	}
}

func buildMessage(code, op, path string) string {
	action := operationLabel(op)
	target := strings.TrimSpace(path)
	if target == "" {
		target = "目标路径"
	}
	switch code {
	case CodePermissionDenied:
		return fmt.Sprintf("没有权限%s：%s", action, target)
	case CodeNotFound:
		return fmt.Sprintf("路径不存在，无法%s：%s", action, target)
	case CodeAlreadyExists:
		return fmt.Sprintf("路径已存在，无法%s：%s", action, target)
	case CodeInvalidPath:
		return fmt.Sprintf("路径无效，无法%s：%s", action, target)
	default:
		return fmt.Sprintf("文件操作失败，无法%s：%s", action, target)
	}
}

func operationLabel(op string) string {
	switch strings.ToLower(strings.TrimSpace(op)) {
	case "read", "open", "stat", "list", "walk":
		return "读取"
	case "write", "create", "mkdir", "rename", "remove", "copy":
		return "写入"
	case "execute", "start":
		return "执行"
	default:
		if strings.TrimSpace(op) == "" {
			return "访问"
		}
		return strings.TrimSpace(op)
	}
}
