
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import fs from "fs";

/* =========================================
   📦 Load Proto
========================================= */

const protoPath = path.resolve(
  __dirname,
  "../../libs/proto/device.proto"
);

const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDefinition) as any;

/* =========================================
   🔐 mTLS Configuration
========================================= */

// Mounted via docker-compose:
// volumes:
//   - ../certs:/certs





// Secure TLS credentials
const credentials = !fs.existsSync("/certs/ca.crt")
  ? grpc.credentials.createInsecure()
  : grpc.credentials.createSsl(
      fs.readFileSync("/certs/ca.crt"),
      fs.readFileSync("/certs/gateway-client.key"),
      fs.readFileSync("/certs/gateway-client.crt")
    );




/* =========================================
   🎯 Create Secure gRPC Client
========================================= */

// Must use service name inside Docker network
const target =
  process.env.GRPC_TARGET || "telemetry-service:50051";

const client = new (proto as any).device.DeviceService(target, credentials);
/* =========================================
   🚀 Create Device (Secure mTLS Call)
========================================= */

export function createDevice(
  tenantId: string,
  serial: string,
  requestId?: string,
  userId?: string,
  jwtToken?: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata();

    // 🔥 Correlation ID
    if (requestId) metadata.set("x-request-id", requestId);

    // 🔐 Tenant isolation
    metadata.set("x-tenant-id", tenantId);

    // Optional user propagation
    if (userId) metadata.set("x-user-id", userId);

    // Forward the raw Authorization header value (already contains "Bearer <token>")
    if (jwtToken) {
      metadata.set("authorization", jwtToken);
    }

    client.CreateDevice(
      {
        tenant_id: tenantId,
        serial_number: serial,
      },
      metadata,
      (err: any, response: any) => {
        if (err) {
          return reject(err);
        }
        resolve(response);
      }
    );
  });
}
