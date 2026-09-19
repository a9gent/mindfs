import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

// The catalog contains lazy loaders, so matching a filename does not load its parser.
export function codeLanguageForPath(path: string): LanguageDescription | null {
  const filename = path.replace(/\\/g, "/").split("/").pop() || "";
  if (/^(?:\.(?:bashrc|bash_profile|zshrc|zprofile)|.*\.zsh)$/i.test(filename)) {
    return LanguageDescription.matchLanguageName(languages, "shell", false);
  }
  return LanguageDescription.matchFilename(languages, filename)
    || LanguageDescription.matchFilename(languages, filename.toLowerCase());
}
