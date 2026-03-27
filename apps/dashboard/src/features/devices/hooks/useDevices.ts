import { useQuery } from "@apollo/client/react";
import { GET_DEVICES, GET_DEVICE, GET_DEVICE_TELEMETRY_HISTORY } from "../queries/devices.graphql";
import type { Device, DeviceTelemetryHistory } from "../types";
export type { Device, DeviceTelemetryHistory };

interface DevicesQueryData {
    devices: Device[];
}

interface DeviceQueryData {
    device: Device | null;
}

interface DeviceTelemetryHistoryQueryData {
    deviceTelemetryHistory: DeviceTelemetryHistory[];
}

export function useDeviceTelemetryHistory(deviceId: string, limit: number = 50) {
    const { data, loading, error } = useQuery<DeviceTelemetryHistoryQueryData>(GET_DEVICE_TELEMETRY_HISTORY, {
        variables: { deviceId, limit },
        skip: !deviceId,
        pollInterval: 30000,
    });
    return {
        telemetryHistory: (data?.deviceTelemetryHistory || []) as DeviceTelemetryHistory[],
        loading,
        error,
    };
}

export function useDevices(limit = 50) {
    const { data, loading, error, refetch } = useQuery<DevicesQueryData>(GET_DEVICES, {
        variables: { limit },
    });
    return {
        devices: (data?.devices || []) as Device[],
        loading,
        error,
        refetch,
    };
}

export function useDevice(deviceId: string) {
    const { data, loading, error } = useQuery<DeviceQueryData>(GET_DEVICE, {
        variables: { deviceId },
        skip: !deviceId,
    });
    return {
        device: data?.device as Device | null,
        loading,
        error,
    };
}

export function useSearchDevices(search: string, limit = 500) {
    const { devices, loading, error } = useDevices(limit);
    const needle = search.trim().toLowerCase();

    const results = needle.length < 2
        ? devices
        : devices.filter((device) =>
            device.serialNumber.toLowerCase().includes(needle) ||
            device.deviceId.toLowerCase().includes(needle)
        );

    return { results, loading, error };
}
