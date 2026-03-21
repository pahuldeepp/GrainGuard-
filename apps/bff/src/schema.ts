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

  type SearchResult {
    deviceId:     String
    tenantId:     String
    serialNumber: String
    temperature:  Float
    humidity:     Float
    recordedAt:   String
    status:       String
    score:        Float
  }

  type PageInfo {
    hasNextPage:     Boolean!
    hasPreviousPage: Boolean!
    startCursor:     String
    endCursor:       String
  }

  type DeviceEdge {
    node:   Device!
    cursor: String!
  }

  type DeviceConnection {
    edges:      [DeviceEdge!]!
    pageInfo:   PageInfo!
    totalCount: Int!
  }

  type MutationResult {
    success: Boolean!
    message: String
  }

  input CreateDeviceInput {
    serialNumber: String!
  }

  input UpdateDeviceInput {
    serialNumber: String
  }

  type Query {
    device(deviceId: String!): Device
    devices(limit: Int): [Device!]!
    devicesConnection(first: Int, after: String): DeviceConnection!
    deviceTelemetry(deviceId: String!): Telemetry
    allTelemetry(limit: Int): [Telemetry!]!
    manyDeviceTelemetry(deviceIds: [String!]!): [Telemetry!]!
    deviceTelemetryHistory(deviceId: String!, limit: Int): [TelemetryHistory!]!
    searchDevices(query: String!, limit: Int): [SearchResult!]!
  }

  type Mutation {
    createDevice(input: CreateDeviceInput!): Device!
    updateDevice(deviceId: String!, input: UpdateDeviceInput!): Device!
    deleteDevice(deviceId: String!): MutationResult!
  }

  type Subscription {
    telemetryUpdated(deviceId: String!): Telemetry!
    tenantTelemetryUpdated(tenantId: String!): Telemetry!
  }
`;