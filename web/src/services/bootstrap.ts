import { appPath } from "./base";
import { e2eeService, type E2EEState } from "./e2ee";

export type RelayStatusPayload = {
  relay_bound?: boolean;
  no_relayer?: boolean;
  pending_code?: string;
  node_name?: string;
  node_id?: string;
  e2ee_node_id?: string;
  relay_base_url?: string;
  node_url?: string;
  last_error?: string;
  e2ee_required?: boolean;
};

export type BootstrapPhase = "idle" | "pending" | "needs_pairing" | "ready" | "error";

export type BootstrapState = {
  phase: BootstrapPhase;
  relayStatus: RelayStatusPayload | null;
  e2ee: E2EEState;
  error: string;
};

type BootstrapListener = (state: BootstrapState) => void;

class BootstrapService {
  private state: BootstrapState = {
    phase: "idle",
    relayStatus: null,
    e2ee: e2eeService.snapshot(),
    error: "",
  };
  private listeners = new Set<BootstrapListener>();
  private startPromise: Promise<BootstrapState> | null = null;

  constructor() {
    e2eeService.subscribe((e2ee) => {
      const patch: Partial<BootstrapState> = { e2ee };
      if (
        this.state.phase === "ready" &&
        e2ee.required &&
        !e2ee.unlocked &&
        !e2ee.secretPresent
      ) {
        patch.phase = "needs_pairing";
      }
      this.setState(patch);
    });
  }

  subscribe(listener: BootstrapListener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): BootstrapState {
    return {
      ...this.state,
      e2ee: e2eeService.snapshot(),
    };
  }

  canUseProtectedAPI(): boolean {
    const state = this.snapshot();
    return state.phase === "ready";
  }

  async start(): Promise<BootstrapState> {
    if (this.state.phase === "ready" || this.state.phase === "needs_pairing") {
      return this.snapshot();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.runStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async refreshRelayStatus(): Promise<RelayStatusPayload | null> {
    const status = await fetchRelayStatus();
    if (status) {
      this.applyRelayStatus(status);
    }
    return status;
  }

  async startRelayBinding(): Promise<RelayStatusPayload | null> {
    const status = await postRelayBindStart();
    if (status) {
      this.applyRelayStatus(status);
    }
    return status;
  }

  async submitPairingSecret(secret: string): Promise<BootstrapState> {
    const trimmed = String(secret || "").trim();
    if (!trimmed) {
      throw new Error("e2ee_secret_missing");
    }
    e2eeService.setSecret(trimmed);
    try {
      await e2eeService.ensureSession();
      await this.refreshRelayStatus();
      this.setState({ phase: "ready", error: "" });
      return this.snapshot();
    } catch (err) {
      if (err instanceof Error && err.message === "e2ee_proof_invalid") {
        e2eeService.clearSecret();
      } else {
        e2eeService.clearSession();
      }
      const code = err instanceof Error ? err.message : "e2ee_open_failed";
      this.setState({ phase: "needs_pairing", error: code });
      throw err;
    }
  }

  private async runStart(): Promise<BootstrapState> {
    this.setState({ phase: "pending", error: "" });
    try {
      const status = await fetchRelayStatus();
      this.applyRelayStatus(status);
      const e2ee = e2eeService.snapshot();
      if (e2ee.required && !e2ee.unlocked) {
        if (e2ee.secretPresent) {
          try {
            await e2eeService.ensureSession();
            await this.refreshRelayStatus();
            this.setState({ phase: "ready", error: "" });
          } catch (err) {
            if (err instanceof Error && err.message === "e2ee_proof_invalid") {
              e2eeService.clearSecret();
            } else {
              e2eeService.clearSession();
            }
            this.setState({ phase: "needs_pairing", error: "" });
          }
        } else {
          this.setState({ phase: "needs_pairing", error: "" });
        }
      } else {
        this.setState({ phase: "ready", error: "" });
      }
      return this.snapshot();
    } catch (err) {
      this.setState({
        phase: "error",
        error: err instanceof Error ? err.message : "bootstrap_failed",
      });
      return this.snapshot();
    }
  }

  private applyRelayStatus(status: RelayStatusPayload | null) {
    const nextStatus = status || null;
    const nodeId = String(nextStatus?.e2ee_node_id || "").trim();
    const required = nextStatus?.e2ee_required === true;
    e2eeService.configure(required, nodeId);
    this.setState({ relayStatus: nextStatus });
  }

  private setState(patch: Partial<BootstrapState>) {
    this.state = {
      ...this.state,
      ...patch,
      e2ee: e2eeService.snapshot(),
    };
    this.emit();
  }

  private emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

async function fetchRelayStatus(): Promise<RelayStatusPayload | null> {
  const target = appPath("/api/relay/status");
  const response = e2eeService.isRequired() && e2eeService.hasSecret()
    ? await e2eeService.protectedFetch(target)
    : await fetch(target);
  if (!response.ok) {
    throw new Error(`relay_status_failed_${response.status}`);
  }
  return e2eeService.parseProtectedJSONResponse<RelayStatusPayload>(response);
}

async function postRelayBindStart(): Promise<RelayStatusPayload | null> {
  const target = appPath("/api/relay/bind/start");
  const init: RequestInit = {
    method: "POST",
  };
  const response = e2eeService.isRequired()
    ? await e2eeService.protectedFetch(target, init)
    : await fetch(target, init);
  if (!response.ok) {
    throw new Error(`relay_bind_start_failed_${response.status}`);
  }
  return e2eeService.parseProtectedJSONResponse<RelayStatusPayload>(response);
}

export const bootstrapService = new BootstrapService();
