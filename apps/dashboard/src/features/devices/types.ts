export interface Device {
  deviceId: string;
  serialNumber: string;
  tenantId: string;
  temperature: number | null;
  humidity: number | null;
  recordedAt: string | null;
}