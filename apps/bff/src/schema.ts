export const typeDefs = `#graphql

  # Telemetry reading from a device
  type Telemetry {
    deviceId:    String!
    temperature: Float
    humidity:    Float
    recordedAt:  String
    updatedAt:   String
    version:     Int
  }

  # Device with its metadata AND latest telemetry combined
  # This is the core BFF type — aggregates two data sources
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

  type Query {
    # Single device with telemetry — queries TWO tables, returns ONE object
    device(deviceId: String!): Device

    # All devices with telemetry
    devices(limit: Int): [Device!]!

    # Telemetry only queries (still useful for telemetry-only views)
    deviceTelemetry(deviceId: String!): Telemetry
    allTelemetry(limit: Int): [Telemetry!]!
    manyDeviceTelemetry(deviceIds: [String!]!): [Telemetry!]!
  }
`;