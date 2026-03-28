import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from "recharts";
import type { DeviceTelemetryHistory } from "../../devices/types";
interface Props {
  history: DeviceTelemetryHistory[];
  loading: boolean;
}

export function TelemetryChart({ history, loading }: Props) {
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-400">
        Loading chart...
      </div>
    );
  }


  if (history.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-400">
        No telemetry history available
      </div>
    );
  }

  const data = history.map((p) => ({
    time: p.recordedAt ? new Date(p.recordedAt).toLocaleTimeString() : "-",
    temperature: p.temperature !== null ? parseFloat(p.temperature.toFixed(1)) : null,
    humidity: p.humidity !== null ? parseFloat(p.humidity.toFixed(1)) : null,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="temperature" stroke="#ef4444" strokeWidth={2} dot={false} name="Temp (C)" />
        <Line type="monotone" dataKey="humidity" stroke="#3b82f6" strokeWidth={2} dot={false} name="Humidity (%)" />
      </LineChart>
    </ResponsiveContainer>
  );
}
