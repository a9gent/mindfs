import { bootstrapService } from "./bootstrap";
import { e2eeService } from "./e2ee";

export class ProtectedAPIError extends Error {
  status: number;
  payload: any;

  constructor(status: number, payload: any, fallback: string) {
    super(String(payload?.message || payload?.error || fallback));
    this.name = "ProtectedAPIError";
    this.status = status;
    this.payload = payload;
  }
}

export function protectedAPIReady(): boolean {
  return bootstrapService.canUseProtectedAPI();
}

export async function protectedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!protectedAPIReady()) {
    throw new Error("api_not_ready");
  }
  return e2eeService.protectedFetch(input, init);
}

export async function protectedJSON<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  if (!protectedAPIReady()) {
    throw new Error("api_not_ready");
  }
  const response = await e2eeService.protectedFetch(input, init);
  const payload = await e2eeService.parseProtectedJSONResponse<any>(response).catch(() => ({}));
  if (!response.ok) {
    throw new ProtectedAPIError(response.status, payload, `request failed: ${response.status}`);
  }
  return payload as T;
}
