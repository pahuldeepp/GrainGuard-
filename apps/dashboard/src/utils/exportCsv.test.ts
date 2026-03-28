import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportDevicesToCsv, buildCsvFilename } from "./exportCsv";
import type { Device } from "../features/devices/types";

const mockClick = vi.fn();
const mockRemove = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
  global.URL.revokeObjectURL = vi.fn();
  vi.spyOn(document.body, "appendChild").mockImplementation(vi.fn());
  const anchor = {
    href: "",
    download: "",
    click: mockClick,
    remove: mockRemove,
  } as unknown as HTMLAnchorElement;
  vi.spyOn(document, "createElement").mockReturnValue({
    ...anchor,
  });
});

const makeDevice = (overrides: Partial<Device> = {}): Device => ({
  deviceId: "device-uuid-001",
  tenantId: "tenant-uuid-001",
  serialNumber: "SN-0001",
  createdAt: "2024-03-17T08:00:00.000Z",
  temperature: 22.5,
  humidity: 65.0,
  recordedAt: "2024-03-17T08:05:38.000Z",
  version: 1,
  ...overrides,
});

// Helper: capture CSV string from Blob
function captureCSV(devices: Device[]): string {
  let captured = "";
  const OrigBlob = global.Blob;
  global.Blob = class extends OrigBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      captured = (parts?.[0] as string) ?? "";
      super(parts, options);
    }
  } as typeof Blob;
  exportDevicesToCsv(devices);
  global.Blob = OrigBlob;
  return captured;
}

describe("exportDevicesToCsv", () => {
  it("does nothing when devices array is empty", () => {
    exportDevicesToCsv([]);
    expect(mockClick).not.toHaveBeenCalled();
  });

  it("triggers download for non-empty devices", () => {
    exportDevicesToCsv([makeDevice()]);
    expect(mockClick).toHaveBeenCalledOnce();
  });

  it("CSV has correct headers", () => {
    const csv = captureCSV([makeDevice()]);
    const headers = csv.split("\n")[0];
    expect(headers).toContain("Serial Number");
    expect(headers).toContain("Device ID");
    expect(headers).toContain("Temperature");
    expect(headers).toContain("Humidity");
  });

  it("formats temperature and humidity to 1 decimal", () => {
    const csv = captureCSV([makeDevice({ temperature: 22.5, humidity: 65.0 })]);
    expect(csv).toContain("22.5");
    expect(csv).toContain("65.0");
  });

  it("outputs empty string for null temperature", () => {
    const csv = captureCSV([makeDevice({ temperature: null })]);
    const dataLine = csv.split("\n")[1];
    const cols = dataLine.split(",");
    expect(cols[3]).toBe("");
  });

  it("outputs empty string for null humidity", () => {
    const csv = captureCSV([makeDevice({ humidity: null })]);
    const dataLine = csv.split("\n")[1];
    const cols = dataLine.split(",");
    expect(cols[4]).toBe("");
  });

  it("escapes values containing commas", () => {
    const csv = captureCSV([makeDevice({ serialNumber: "SN,001" })]);
    expect(csv).toContain('"SN,001"');
  });

  it("escapes values containing double quotes", () => {
    const csv = captureCSV([makeDevice({ serialNumber: 'SN"001' })]);
    expect(csv).toContain('"SN""001"');
  });
});

describe("buildCsvFilename", () => {
  it("includes today date", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(buildCsvFilename(false, 50)).toContain(today);
  });

  it("includes all- prefix when not filtering", () => {
    expect(buildCsvFilename(false, 50)).toContain("all-50");
  });

  it("includes filtered- prefix when filtering", () => {
    expect(buildCsvFilename(true, 10)).toContain("filtered-10");
  });

  it("starts with grainguard-devices", () => {
    expect(buildCsvFilename(false, 50)).toMatch(/^grainguard-devices/);
  });

  it("ends with .csv", () => {
    expect(buildCsvFilename(false, 50)).toMatch(/\.csv$/);
  });
});
