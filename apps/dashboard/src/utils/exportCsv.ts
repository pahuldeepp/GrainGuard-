import type { Device } from "../features/devices/types";

export function exportDevicesToCsv(devices: Device[], filename = "devices.csv"): void {
  if (devices.length === 0) return;

  const headers = [
    "Serial Number",
    "Device ID",
    "Tenant ID",
    "Temperature (°C)",
    "Humidity (%)",
    "Last Reading",
  ];

  const rows = devices.map((d) => [
    d.serialNumber,
    d.deviceId,
    d.tenantId,
    d.temperature !== null ? d.temperature.toFixed(1) : "",
    d.humidity !== null ? d.humidity.toFixed(1) : "",
    d.recordedAt ? new Date(d.recordedAt).toLocaleString() : "",
  ]);

  const escape = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  
  const csv = [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
export function buildCsvFilename(isFiltering: boolean, count: number): string {
  const date = new Date().toISOString().split("T")[0];
  const suffix = isFiltering ? `filtered-${count}` : `all-${count}`;
  return `grainguard-devices-${suffix}-${date}.csv`;
}

