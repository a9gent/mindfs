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
  const response = await fetch(`/api/upload?${query.toString()}`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
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
