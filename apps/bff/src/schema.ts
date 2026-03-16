export const typeDefs = `#graphql
  type Telemetry {
    deviceId:    String!
    temperature: Float
    humidity:    Float
    recordedAt:  String
    updatedAt:   String
    version:     Int
  }

  type Device {
    deviceId:     String!
    tenantId:     String!
    serialNumber: String!
    createdAt:    String!
    temperature:  Float
    humidity:     Float
    recordedAt:   String
    version:      Int
  }

  type TelemetryHistory {
    deviceId:    String!
    temperature: Float!
    humidity:    Float!
    recordedAt:  String!
  }

  type Query {
    device(deviceId: String!): Device
    devices(limit: Int): [Device!]!
    deviceTelemetry(deviceId: String!): Telemetry
    allTelemetry(limit: Int): [Telemetry!]!
    manyDeviceTelemetry(deviceIds: [String!]!): [Telemetry!]!
    deviceTelemetryHistory(deviceId: String!, limit: Int): [TelemetryHistory!]!
  }

  type Subscription {
    telemetryUpdated(deviceId: String!): Telemetry!
    tenantTelemetryUpdated(tenantId: String!): Telemetry!
  }
`;
