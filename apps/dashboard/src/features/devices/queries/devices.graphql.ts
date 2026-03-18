import { gql } from "@apollo/client";

export const GET_DEVICES = gql`
  query GetDevices($limit: Int) {
    devices(limit: $limit) {
      deviceId
      serialNumber
      tenantId  
      temperature
      humidity
      recordedAt
    }
  }
`;

export const GET_DEVICE_TELEMETRY_HISTORY = gql`
  query GetDeviceTelemetryHistory($deviceId: String!, $limit: Int) {
    deviceTelemetryHistory(deviceId: $deviceId, limit: $limit) {
      deviceId
      temperature
      humidity
      recordedAt
    }
  }
`;

export const GET_DEVICE = gql`
  query GetDevice($deviceId: String!) {
    device(deviceId: $deviceId) {
      deviceId
      serialNumber
      tenantId
      temperature
      humidity
      recordedAt
    }
  }
`;
export const SEARCH_DEVICES = gql;
