type InputSession = {
  key?: string;
  session_key?: string;
  root_id?: string;
};

// An open drawer owns the input, including an empty drawer starting a session.
// A closed drawer must never supply a remembered, invisible send target.
export function resolveInputSession<T extends InputSession>(
  rootId: string | null | undefined,
  drawerOpen: boolean,
  mainSession: T | null | undefined,
  drawerSession: T | null | undefined,
): T | null {
  if (!rootId) return null;
  const session = drawerOpen ? drawerSession : mainSession;
  if (!session || (session.root_id && session.root_id !== rootId)) return null;
  return session.key || session.session_key ? session : null;
}
