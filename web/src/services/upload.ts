import { appURL } from "./base";
import { e2eeService } from "./e2ee";

export type UploadedFile = {
  path: string;
  name: string;
  mime: string;
  size: number;
};

type UploadResponse = {
  files?: UploadedFile[];
};

export async function uploadFiles(params: {
  rootId: string;
  files: File[];
  dir?: string;
}): Promise<UploadedFile[]> {
  const formData = new FormData();
  params.files.forEach((file) => {
    formData.append("files", file);
  });
  if (params.dir) {
    formData.append("dir", params.dir);
  }

  const query = new URLSearchParams({ root: params.rootId });
  const requestURL = appURL("/api/upload", query);
  const headers = e2eeService.isRequired()
    ? await e2eeService.fileProofHeaders("POST", requestURL)
    : undefined;
  const response = await fetch(requestURL, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!response.ok) {
    if (response.status === 401 && e2eeService.isRequired()) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (e2eeService.handleServerError(String(payload.error || ""))) {
        return uploadFiles(params);
      }
      throw new Error(payload.error || `Upload failed: ${response.status}`);
    }
    let message = `Upload failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
    }
    throw new Error(message);
  }
  const payload = (await response.json()) as UploadResponse;
  return Array.isArray(payload.files) ? payload.files : [];
}
