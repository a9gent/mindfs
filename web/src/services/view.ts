// View service for MindFS

const API_BASE = "/api";

export type ViewRouteInfo = {
  route_id: string;
  route_name: string;
  priority: number;
  is_default: boolean;
  view_data?: Record<string, unknown> | null;
};

// Fetch matching view routes for a root (optionally filtered by path)
export async function fetchViewRoutes(rootId: string, path?: string): Promise<ViewRouteInfo[]> {
  let url = `${API_BASE}/view/routes?root=${encodeURIComponent(rootId)}`;
  if (path) {
    url += `&path=${encodeURIComponent(path)}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return (data.routes || []).map((r: ViewRouteInfo) => ({
    route_id: r.route_id,
    route_name: r.route_name,
    priority: r.priority,
    is_default: r.is_default,
    view_data: r.view_data ?? null,
  }));
}

// Save user preference for a path
export async function saveViewPreference(
  rootId: string,
  path: string,
  routeId: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/view/preference`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      root_id: rootId,
      path: path,
      route_id: routeId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save preference: ${response.statusText}`);
  }
}
