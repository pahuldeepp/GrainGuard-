export interface Device {
  deviceId: string;
  serialNumber: string;
  tenantId: string;
  createdAt?: string;
  temperature: number | null;
  humidity: number | null;
  recordedAt: string | null;
  version?: number;
}

export interface DeviceTelemetryHistory {
  deviceId: string;
  temperature: number | null;
  humidity: number | null;
  recordedAt: string | null;
}
