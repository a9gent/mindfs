import { appURL } from "./base";

const SECRET_STORAGE_PREFIX = "mindfs.e2ee.secret.";
export const E2EE_HEADER = "X-MindFS-E2EE";
export const CLIENT_ID_HEADER = "X-MindFS-Client-ID";
export const PROOF_HEADER = "X-MindFS-Proof";
export const TS_HEADER = "X-MindFS-TS";

type E2EEState = {
  required: boolean;
  nodeId: string;
  secretPresent: boolean;
  unlocked: boolean;
};

type E2EEListener = (state: E2EEState) => void;

type OpenResponse = {
  ok?: boolean;
  node_eph_pk?: string;
  server_nonce?: string;
  server_proof?: string;
};

type CipherEnvelope = {
  nonce: string;
  ciphertext: string;
};

type SessionContext = {
  transportKey: CryptoKey;
  transportKeyBytes: Uint8Array;
};

class E2EEService {
  private required = false;
  private nodeId = "";
  private clientId = "";
  private session: SessionContext | null = null;
  private listeners = new Set<E2EEListener>();
  private openingPromise: Promise<SessionContext> | null = null;

  subscribe(listener: E2EEListener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  configure(required: boolean, nodeId: string) {
    const nextRequired = required === true;
    const nextNodeId = String(nodeId || "").trim();
    const changed = this.required !== nextRequired || this.nodeId !== nextNodeId;
    this.required = nextRequired;
    if (this.nodeId !== nextNodeId) {
      this.nodeId = nextNodeId;
      this.session = null;
      this.openingPromise = null;
    }
    if (changed) {
      this.emit();
    }
  }

  setClientId(clientId: string) {
    const nextClientId = String(clientId || "").trim();
    if (this.clientId === nextClientId) {
      return;
    }
    this.clientId = nextClientId;
    this.session = null;
    this.openingPromise = null;
    this.emit();
  }

  snapshot(): E2EEState {
    return {
      required: this.required,
      nodeId: this.nodeId,
      secretPresent: this.hasSecret(),
      unlocked: !!this.session,
    };
  }

  hasSecret(): boolean {
    if (!this.nodeId || typeof window === "undefined") {
      return false;
    }
    return !!window.localStorage.getItem(this.secretStorageKey());
  }

  getSecret(): string {
    if (!this.nodeId || typeof window === "undefined") {
      return "";
    }
    return String(window.localStorage.getItem(this.secretStorageKey()) || "").trim();
  }

  setSecret(secret: string) {
    const trimmed = String(secret || "").trim();
    if (!this.nodeId || typeof window === "undefined") {
      return;
    }
    if (!trimmed) {
      window.localStorage.removeItem(this.secretStorageKey());
    } else {
      window.localStorage.setItem(this.secretStorageKey(), trimmed);
    }
    this.session = null;
    this.openingPromise = null;
    this.emit();
  }

  clearSession() {
    this.session = null;
    this.openingPromise = null;
    this.emit();
  }

  clearSecret() {
    if (typeof window !== "undefined" && this.nodeId) {
      window.localStorage.removeItem(this.secretStorageKey());
    }
    this.clearSession();
  }

  async ensureSession(): Promise<SessionContext | null> {
    if (!this.required) {
      return null;
    }
    if (this.session) {
      return this.session;
    }
    if (this.openingPromise) {
      return this.openingPromise;
    }
    const secret = this.getSecret();
    if (!secret || !this.nodeId || !this.clientId) {
      this.emit();
      throw new Error("e2ee_secret_missing");
    }
    this.openingPromise = this.open(secret);
    try {
      this.session = await this.openingPromise;
      this.emit();
      return this.session;
    } finally {
      this.openingPromise = null;
    }
  }

  async encryptEnvelope(value: unknown): Promise<CipherEnvelope | null> {
    const session = await this.ensureSession();
    if (!session) return null;
    return encryptJSON(session.transportKey, value);
  }

  async decryptEnvelope<T>(envelope: CipherEnvelope): Promise<T> {
    const session = await this.ensureSession();
    if (!session) {
      throw new Error("e2ee_required");
    }
    return decryptJSON<T>(session.transportKey, envelope);
  }

  async encodeProtectedJSON(value: unknown): Promise<string> {
    const envelope = await this.encryptEnvelope(value);
    if (!envelope) {
      throw new Error("e2ee_required");
    }
    return JSON.stringify(envelope);
  }

  async decodeProtectedJSON<T>(raw: string): Promise<T> {
    const envelope = JSON.parse(raw) as CipherEnvelope;
    return this.decryptEnvelope<T>(envelope);
  }

  async encodeWSMessage(value: unknown): Promise<string> {
    return this.encodeProtectedJSON(value);
  }

  async decodeWSMessage<T>(raw: string): Promise<T> {
    return this.decodeProtectedJSON<T>(raw);
  }

  sessionProtectedHeaders(headers?: HeadersInit): Headers {
    const next = new Headers(headers);
    next.set(E2EE_HEADER, "1");
    next.set(CLIENT_ID_HEADER, this.clientId);
    return next;
  }

  async fileProofHeaders(method: string, path: string, headers?: HeadersInit): Promise<Headers> {
    const session = await this.ensureSession();
    if (!session) {
      throw new Error("e2ee_required");
    }
    const ts = new Date().toISOString();
    const proofPath = canonicalProofPath(path);
    const proof = await buildRequestProof(session.transportKeyBytes, method, proofPath, ts, this.clientId);
    const next = new Headers(headers);
    next.set(CLIENT_ID_HEADER, this.clientId);
    next.set(TS_HEADER, ts);
    next.set(PROOF_HEADER, proof);
    return next;
  }

  isProtectedJSONResponse(response: Response): boolean {
    return String(response.headers.get(E2EE_HEADER) || "").trim() === "1";
  }

  async parseProtectedJSONResponse<T>(response: Response): Promise<T> {
    if (!this.isProtectedJSONResponse(response)) {
      return response.json() as Promise<T>;
    }
    return this.decodeProtectedJSON<T>(await response.text());
  }

  isRequired(): boolean {
    return this.required;
  }

  currentClientId(): string {
    return this.clientId;
  }

  handleServerError(code: string): boolean {
    const normalized = String(code || "").trim();
    if (!normalized) {
      return false;
    }
    if (
      normalized === "e2ee_session_missing" ||
      normalized === "e2ee_session_expired"
    ) {
      this.clearSession();
      return true;
    }
    if (normalized === "e2ee_proof_invalid") {
      this.clearSecret();
      return true;
    }
    return false;
  }

  private async open(secret: string): Promise<SessionContext> {
    if (!globalThis.isSecureContext) {
      throw new Error("e2ee_secure_context_required");
    }
    if (!globalThis.crypto?.subtle) {
      throw new Error("e2ee_webcrypto_unavailable");
    }
    const clientKeys = await crypto.subtle.generateKey(
      {
        name: "ECDH",
        namedCurve: "P-256",
      },
      true,
      ["deriveBits"],
    );
    const rawPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", clientKeys.publicKey),
    );
    const clientNonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const clientEphPK = encodeBase64(rawPublicKey);
    const clientNonce = encodeBase64(clientNonceBytes);
    const proof = await buildOpenProof(secret, this.nodeId, clientEphPK, clientNonce);

    const response = await fetch(appURL("/api/e2ee/open"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        node_id: this.nodeId,
        client_eph_pk: clientEphPK,
        client_nonce: clientNonce,
        proof,
        proto_version: 1,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as OpenResponse & {
      error?: string;
    };
    if (!response.ok) {
      const code = String(payload?.error || `e2ee_open_failed_${response.status}`);
      this.handleServerError(code);
      throw new Error(code);
    }
    const nodeEphPK = String(payload.node_eph_pk || "").trim();
    const serverNonce = String(payload.server_nonce || "").trim();
    const serverProof = String(payload.server_proof || "").trim();
    if (!nodeEphPK || !serverNonce || !serverProof) {
      throw new Error("e2ee_open_invalid_response");
    }
    const expectedServerProof = await buildAcceptProof(
      secret,
      this.nodeId,
      clientEphPK,
      nodeEphPK,
      clientNonce,
      serverNonce,
    );
    if (expectedServerProof !== serverProof) {
      throw new Error("e2ee_proof_invalid");
    }
    const nodePub = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64(nodeEphPK)),
      {
        name: "ECDH",
        namedCurve: "P-256",
      },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: nodePub },
        clientKeys.privateKey,
        256,
      ),
    );
    const sessionMaster = await hkdfBytes(
      sharedSecret,
      await sha256Bytes(secret),
      await sha256Bytes([this.nodeId, clientEphPK, nodeEphPK, clientNonce, serverNonce].join("\x1f")),
      32,
    );
    const transportKeyBytes = await hkdfBytes(sessionMaster, null, new TextEncoder().encode("transport"), 32);
    const transportKey = await importAesKey(transportKeyBytes);
    return {
      transportKey,
      transportKeyBytes,
    };
  }

  private secretStorageKey(): string {
    return `${SECRET_STORAGE_PREFIX}${this.nodeId}`;
  }

  private emit() {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

async function buildOpenProof(secret: string, nodeId: string, clientEphPK: string, clientNonce: string): Promise<string> {
  return buildHmacProof(secret, "mindfs-e2ee-open", [nodeId, clientEphPK, clientNonce]);
}

async function buildAcceptProof(secret: string, nodeId: string, clientEphPK: string, nodeEphPK: string, clientNonce: string, serverNonce: string): Promise<string> {
  return buildHmacProof(secret, "mindfs-e2ee-accept", [nodeId, clientEphPK, nodeEphPK, clientNonce, serverNonce]);
}

async function buildHmacProof(secret: string, label: string, parts: string[]): Promise<string> {
    const secretKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(new TextEncoder().encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
  );
  const digest = await sha256Bytes([label, ...parts].join("\x1f"));
  const signature = await crypto.subtle.sign("HMAC", secretKey, digest);
  return encodeBase64(new Uint8Array(signature));
}

async function encryptJSON(key: CryptoKey, value: unknown): Promise<CipherEnvelope> {
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(value)));
}

async function decryptJSON<T>(key: CryptoKey, envelope: CipherEnvelope): Promise<T> {
  const plaintext = await decryptBytes(key, envelope);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<CipherEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    toArrayBuffer(bytes),
  );
  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptBytes(key: CryptoKey, envelope: CipherEnvelope): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(decodeBase64(envelope.nonce)) },
    key,
    toArrayBuffer(decodeBase64(envelope.ciphertext)),
  );
  return new Uint8Array(plaintext);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function buildRequestProof(key: Uint8Array, method: string, path: string, ts: string, clientId: string): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await sha256Bytes(["mindfs-request-proof", method, path, ts, clientId].join("\x1f"));
  const signature = await crypto.subtle.sign("HMAC", hmacKey, digest);
  return encodeBase64(new Uint8Array(signature));
}

async function hkdfBytes(secret: Uint8Array, salt: Uint8Array | ArrayBuffer | null, info: Uint8Array | ArrayBuffer, length: number): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", toArrayBuffer(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ? toArrayBuffer(toUint8Array(salt)) : new Uint8Array(),
      info: toArrayBuffer(toUint8Array(info)),
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function sha256Bytes(value: string): Promise<Uint8Array>;
async function sha256Bytes(value: Uint8Array): Promise<Uint8Array>;
async function sha256Bytes(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function canonicalProofPath(path: string): string {
  const raw = String(path || "").trim();
  if (!raw) {
    return "";
  }
  const target = new URL(raw, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const pathname = target.pathname.replace(/^\/n\/[^/]+/, "") || "/";
  return target.search ? `${pathname}${target.search}` : pathname;
}

export const e2eeService = new E2EEService();
export type { CipherEnvelope, E2EEState };
