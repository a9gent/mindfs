package router

import (
	"path/filepath"
	"strings"
)

// matchesRule checks if a path matches a rule
func matchesRule(path string, rule MatchRule) bool {
	// Handle OR combination
	if len(rule.Any) > 0 {
		for _, subRule := range rule.Any {
			if matchesRule(path, subRule) {
				return true
			}
		}
		return false
	}

	// Handle AND combination
	if len(rule.All) > 0 {
		for _, subRule := range rule.All {
			if !matchesRule(path, subRule) {
				return false
			}
		}
		return true
	}

	// Check individual rules
	matched := true

	if rule.Path != "" {
		matched = matched && matchGlob(path, rule.Path)
	}

	if rule.Ext != "" {
		ext := filepath.Ext(path)
		matched = matched && matchExtension(ext, rule.Ext)
	}

	if rule.Mime != "" {
		mime := guessMimeType(path)
		matched = matched && matchMime(mime, rule.Mime)
	}

	if rule.Name != "" {
		name := filepath.Base(path)
		matched = matched && matchGlob(name, rule.Name)
	}

	return matched
}

// matchGlob performs glob pattern matching
func matchGlob(path, pattern string) bool {
	// Handle ** for recursive matching
	if strings.Contains(pattern, "**") {
		return matchDoubleStarGlob(path, pattern)
	}

	// Use standard filepath.Match for simple patterns
	matched, err := filepath.Match(pattern, path)
	if err != nil {
		return false
	}
	return matched
}

// matchDoubleStarGlob handles ** patterns
func matchDoubleStarGlob(path, pattern string) bool {
	// Split pattern by **
	parts := strings.Split(pattern, "**")

	if len(parts) == 1 {
		// No ** in pattern
		matched, err := filepath.Match(pattern, path)
		return err == nil && matched
	}

	// Handle patterns like "**/*.md"
	if parts[0] == "" && len(parts) == 2 {
		// Pattern starts with **
		suffix := parts[1]
		if suffix == "" || suffix == "/" {
			return true // ** matches everything
		}
		// Remove leading /
		suffix = strings.TrimPrefix(suffix, "/")
		// Check if path ends with suffix pattern
		matched, err := filepath.Match(suffix, filepath.Base(path))
		if err != nil {
			return false
		}
		if matched {
			return true
		}
		// Also try matching the full path
		matched, err = filepath.Match("*"+suffix, path)
		if err != nil {
			return false
		}
		return matched
	}

	// Handle patterns like "src/**/*.ts"
	if len(parts) == 2 {
		prefix := strings.TrimSuffix(parts[0], "/")
		suffix := strings.TrimPrefix(parts[1], "/")

		// Check prefix
		if prefix != "" && !strings.HasPrefix(path, prefix) {
			return false
		}

		// Check suffix
		if suffix != "" {
			pathWithoutPrefix := path
			if prefix != "" {
				pathWithoutPrefix = strings.TrimPrefix(path, prefix)
				pathWithoutPrefix = strings.TrimPrefix(pathWithoutPrefix, "/")
			}
			matched, err := filepath.Match(suffix, filepath.Base(pathWithoutPrefix))
			return err == nil && matched
		}

		return true
	}

	// Complex patterns with multiple ** - simplified handling
	return strings.Contains(path, strings.ReplaceAll(pattern, "**", ""))
}

// matchExtension checks if extension matches
func matchExtension(ext, pattern string) bool {
	// Normalize extensions
	if !strings.HasPrefix(ext, ".") && ext != "" {
		ext = "." + ext
	}
	if !strings.HasPrefix(pattern, ".") && pattern != "" {
		pattern = "." + pattern
	}

	// Handle multiple extensions like ".ts,.tsx"
	if strings.Contains(pattern, ",") {
		for _, p := range strings.Split(pattern, ",") {
			if strings.TrimSpace(p) == ext {
				return true
			}
		}
		return false
	}

	return ext == pattern
}

// matchMime checks if mime type matches pattern
func matchMime(mime, pattern string) bool {
	// Handle wildcard like "image/*"
	if strings.HasSuffix(pattern, "/*") {
		prefix := strings.TrimSuffix(pattern, "/*")
		return strings.HasPrefix(mime, prefix+"/")
	}

	return mime == pattern
}

// guessMimeType guesses mime type from file extension
func guessMimeType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))

	mimeTypes := map[string]string{
		".html": "text/html",
		".htm":  "text/html",
		".css":  "text/css",
		".js":   "application/javascript",
		".ts":   "application/typescript",
		".tsx":  "application/typescript",
		".jsx":  "application/javascript",
		".json": "application/json",
		".xml":  "application/xml",
		".md":   "text/markdown",
		".txt":  "text/plain",
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".svg":  "image/svg+xml",
		".webp": "image/webp",
		".pdf":  "application/pdf",
		".go":   "text/x-go",
		".py":   "text/x-python",
		".rs":   "text/x-rust",
		".java": "text/x-java",
		".c":    "text/x-c",
		".cpp":  "text/x-c++",
		".h":    "text/x-c",
	}

	if mime, ok := mimeTypes[ext]; ok {
		return mime
	}

	return "application/octet-stream"
}
