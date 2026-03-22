import { useQuery } from "@apollo/client/react";
import { GET_DEVICES, GET_DEVICE, GET_DEVICE_TELEMETRY_HISTORY, SEARCH_DEVICES } from "../queries/devices.graphql";
import type { Device, DeviceTelemetryHistory } from "../types";
export type { Device, DeviceTelemetryHistory };

export function useDeviceTelemetryHistory(deviceId: string, limit: number = 50) {
    const { data, loading, error } = useQuery(GET_DEVICE_TELEMETRY_HISTORY, {
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
    const { data, loading, error, refetch } = useQuery(GET_DEVICES, {
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
    const { data, loading, error } = useQuery(GET_DEVICE, {
        variables: { deviceId },
        skip: !deviceId,
    });
    return {
        device: data?.device as Device | null,
        loading,
        error,
    };
}

export function useSearchDevices(query: string, limit = 20) {
    const { data, loading, error } = useQuery(SEARCH_DEVICES, {
        variables: { query, limit },
        skip: query.trim().length < 2,
    });
    return {
        results: (data?.searchDevices || []) as Device[],
        loading,
        error,
    };
}

