import json, urllib.request

rows = open('/tmp/devices.csv').readlines()
print(f"Indexing {len(rows)} devices...")
bulk_body = []
for row in rows:
    parts = row.strip().split(',')
    if len(parts) < 3:
        continue
    device_id, tenant_id, serial_number = parts[0], parts[1], parts[2]
    temperature = float(parts[3]) if len(parts) > 3 and parts[3] else None
    humidity = float(parts[4]) if len(parts) > 4 and parts[4] else None
    bulk_body.append(json.dumps({"index": {"_index": "grainguard-devices", "_id": device_id}}))
    bulk_body.append(json.dumps({"device_id": device_id, "tenant_id": tenant_id, "serial_number": serial_number, "temperature": temperature, "humidity": humidity, "status": "active"}))
body = '\n'.join(bulk_body) + '\n'
req = urllib.request.Request('http://localhost:9200/_bulk', data=body.encode('utf-8'), headers={'Content-Type': 'application/x-ndjson'}, method='POST')
resp = urllib.request.urlopen(req)
result = json.loads(resp.read())
print(f"Done — errors: {result.get('errors', False)}")
