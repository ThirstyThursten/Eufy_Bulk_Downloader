const BASE = "/api";

export interface SimpleDevice {
  serialNumber: string;
  name: string;
  model: string;
  type: number;
  stationSerialNumber: string;
  isCamera: boolean;
}

export interface SimpleStation {
  serialNumber: string;
  name: string;
  model: string;
}

export interface EventRecord {
  id: string;
  deviceSerialNumber: string;
  deviceName: string;
  stationSerialNumber: string;
  storagePath: string;
  cipherId: number;
  startTime: number;
  endTime: number;
  thumbPath: string;
  hasHuman: boolean;
  videoType: number;
}

export interface EventDownloadInfo {
  eventId: string;
  startTime: number;
  endTime: number;
  status: "pending" | "downloading" | "done" | "failed";
  error?: string;
  outputPath?: string;
}

export interface DownloadJob {
  id: string;
  deviceSerialNumber: string;
  deviceName: string;
  from: number;
  to: number;
  events: EventDownloadInfo[];
  status: "running" | "completed" | "failed" | "cancelled";
  maxConcurrent: number;
  createdAt: number;
  completedAt?: number;
}

export interface ConnectionStatus {
  status: string;
  captcha: { id: string; imageBase64: string } | null;
  error: string | null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export async function getStatus(): Promise<ConnectionStatus> {
  return fetchJson(`${BASE}/status`);
}

export async function submitTfa(code: string): Promise<{ status: string }> {
  return fetchJson(`${BASE}/auth/tfa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export async function submitCaptcha(
  captchaId: string,
  captchaCode: string
): Promise<{ status: string }> {
  return fetchJson(`${BASE}/auth/captcha`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ captchaId, captchaCode }),
  });
}

export async function getDevices(): Promise<{
  devices: SimpleDevice[];
  stations: SimpleStation[];
}> {
  return fetchJson(`${BASE}/devices`);
}

export async function getEvents(
  deviceId: string,
  from: string,
  to: string
): Promise<{ events: EventRecord[] }> {
  const params = new URLSearchParams({ deviceId, from, to });
  return fetchJson(`${BASE}/events?${params}`);
}

export async function startDownload(
  deviceId: string,
  from: string,
  to: string,
  eventIds?: string[],
  maxConcurrent?: number
): Promise<{ jobId: string }> {
  return fetchJson(`${BASE}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, from, to, eventIds, maxConcurrent }),
  });
}

export async function getJobs(): Promise<{ jobs: DownloadJob[] }> {
  return fetchJson(`${BASE}/jobs`);
}

export async function cancelJob(
  jobId: string
): Promise<{ status: string }> {
  return fetchJson(`${BASE}/jobs/${jobId}/cancel`, { method: "POST" });
}
