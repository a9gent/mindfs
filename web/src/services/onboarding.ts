import { getStoredString, setStoredString } from "./storage";

export const ONBOARDING_VERSION = 2;
const ONBOARDING_STORAGE_KEY = "mindfs-onboarding-state";

export type OnboardingState = {
  version: number;
  completedAt?: string;
  dismissedAt?: string;
  seenHints: string[];
};

function emptyState(): OnboardingState {
  return { version: ONBOARDING_VERSION, seenHints: [] };
}

export function readOnboardingState(): OnboardingState {
  const raw = getStoredString(ONBOARDING_STORAGE_KEY);
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (parsed.version !== ONBOARDING_VERSION) return emptyState();
    return {
      version: ONBOARDING_VERSION,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      dismissedAt: typeof parsed.dismissedAt === "string" ? parsed.dismissedAt : undefined,
      seenHints: Array.isArray(parsed.seenHints)
        ? parsed.seenHints.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return emptyState();
  }
}

function writeOnboardingState(state: OnboardingState): void {
  setStoredString(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
}

export function shouldAutoStartOnboarding(): boolean {
  const state = readOnboardingState();
  return !state.completedAt && !state.dismissedAt;
}

export function completeOnboarding(): void {
  writeOnboardingState({
    ...readOnboardingState(),
    completedAt: new Date().toISOString(),
    dismissedAt: undefined,
  });
}

export function dismissOnboarding(): void {
  writeOnboardingState({
    ...readOnboardingState(),
    dismissedAt: new Date().toISOString(),
  });
}

export function hasSeenOnboardingHint(hint: string): boolean {
  return readOnboardingState().seenHints.includes(hint);
}

export function markOnboardingHintSeen(hint: string): void {
  const state = readOnboardingState();
  if (state.seenHints.includes(hint)) return;
  writeOnboardingState({ ...state, seenHints: [...state.seenHints, hint] });
}
