// Shows temperature or humidity with color coding
// Green = normal, Yellow = warning, Red = critical
interface Props {
  value: number | null;
  unit: string;
  low?: number;
  high?: number;
}

export function TelemetryBadge({ value, unit, low = 0, high = 100 }: Props) {
  if (value === null) {
    return <span className="text-gray-400 text-sm">No Data</span>;
  }
  
  const isWarning = value > high *0.8 || value < low *0.8;
  
  const isCritical = value > high || value < low;
  
  const color = isCritical ? "text-red-600" : isWarning ? "text-yellow-600" : "text-green-600";
  
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-full text-sm font-medium ${color}`}>
      {value.toFixed(1)} {unit}
    </span>
  );
}