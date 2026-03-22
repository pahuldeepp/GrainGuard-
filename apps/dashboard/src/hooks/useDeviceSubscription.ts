import { useSubscription, gql } from "@apollo/client";

const TELEMETRY_UPDATED = gql`
  subscription TelemetryUpdated($deviceId: String!) {
    telemetryUpdated(deviceId: $deviceId) {
      deviceId
      temperature
      humidity
      recordedAt
      updatedAt
      version
    }
  }
`;

const TENANT_TELEMETRY_UPDATED = gql`
  subscription TenantTelemetryUpdated($tenantId: String!) {
    tenantTelemetryUpdated(tenantId: $tenantId) {
      deviceId
      temperature
      humidity
      recordedAt
      updatedAt
      version
    }
  }
`;

export function useDeviceSubscription(deviceId: string) {
  const { data, loading, error } = useSubscription(TELEMETRY_UPDATED, {
    variables: { deviceId },
    skip: !deviceId,
  });

  return {
    liveData: data?.telemetryUpdated ?? null,
    isLive: !!data?.telemetryUpdated,
    loading,
    error,
  };
}

export function useTenantTelemetrySubscription(tenantId: string) {
  const { data, loading, error } = useSubscription(TENANT_TELEMETRY_UPDATED, {
    variables: { tenantId },
    skip: !tenantId,
  });

  return {
    latestUpdate: data?.tenantTelemetryUpdated ?? null,
    loading,
    error,
  };
}

