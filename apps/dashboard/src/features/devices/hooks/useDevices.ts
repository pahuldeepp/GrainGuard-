import { useQuery } from "@apollo/client/react";
import {GET_DEVICES, GET_DEVICE} from "../queries/devices.graphql";

export interface Device{
    deviceId: string;
    serialNumber: string;
    tenantId: string;
    temperature: number | null;
    humidity: number | null;
    recordedAt: string | null;
}

export function useDevices(limit=50) {
    const {data, loading, error, refetch} = useQuery(GET_DEVICES, {
        variables: {
            limit,
        },
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