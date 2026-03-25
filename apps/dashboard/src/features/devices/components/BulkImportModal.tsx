import { useRef, useState } from "react";
import { getAccessTokenSilently } from "../../../lib/auth0";

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface Progress {
  total: number;
  done: number;
  errors: number;
  current?: string;
  status?: "ok" | "error";
  message?: string;
  finished?: boolean;
  error?: string;
}

const GW = import.meta.env.VITE_GATEWAY_URL ?? "";

export function BulkImportModal({ open, onClose, onSuccess }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress]   = useState<Progress | null>(null);
  const [importing, setImporting] = useState(false);
  const [log, setLog]             = useState<string[]>([]);

  function reset() {
    setProgress(null);
    setImporting(false);
    setLog([]);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setImporting(true);
    setProgress(null);
    setLog([]);

    try {
      const token = await getAccessTokenSilently();

      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${GW}/devices/bulk`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.body) throw new Error("No response body");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;

          try {
            const event = JSON.parse(line) as Progress;
            setProgress(event);

            if (event.current) {
              const emoji = event.status === "error" ? "✗" : "✓";
              const msg   = event.status === "error" ? ` — ${event.message}` : "";
              setLog((prev) => [`${emoji} ${event.current}${msg}`, ...prev].slice(0, 100));
            }

            if (event.finished) {
              setImporting(false);
              if (event.errors === 0) onSuccess();
            }

            if (event.error) {
              setImporting(false);
            }
          } catch {
            // malformed JSON — skip
          }
        }
      }
    } catch (err) {
      setLog((prev) => [`Error: ${err instanceof Error ? err.message : "unknown"}`, ...prev]);
      setImporting(false);
    }
  }

  if (!open) return null;

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-import-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget && !importing) { reset(); onClose(); } }}
    >
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <h2 id="bulk-import-title" className="text-lg font-bold text-gray-900 dark:text-white mb-1">
          Bulk Import Devices
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Upload a CSV file with one serial number per row. Max 1,000 rows per upload.
        </p>

        <a
          href={`data:text/csv;charset=utf-8,serialNumber%0ASN00100001%0ASN00100002`}
          download="device-import-template.csv"
          className="inline-block text-xs text-green-600 dark:text-green-400 hover:underline mb-4"
        >
          ↓ Download CSV template
        </a>

        {!progress && (
          <form onSubmit={handleUpload}>
            <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-8 text-center">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                id="csv-file"
                onChange={() => {}}
              />
              <label
                htmlFor="csv-file"
                className="cursor-pointer text-sm text-gray-600 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400"
              >
                Click to choose a CSV file or drag and drop
              </label>
            </div>

            <div className="flex justify-end gap-3 mt-4">
              <button type="button" onClick={() => { reset(); onClose(); }} className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                Cancel
              </button>
              <button type="submit" className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
                Upload & Import
              </button>
            </div>
          </form>
        )}

        {progress && (
          <div>
            <div className="mb-3">
              <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                <span>{progress.done} / {progress.total} processed</span>
                <span>{pct}%</span>
              </div>
              <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${progress.errors > 0 ? "bg-yellow-500" : "bg-green-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {progress.errors > 0 && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                  {progress.errors} error(s) — other rows still processed
                </p>
              )}
            </div>

            <div className="h-40 overflow-y-auto font-mono text-xs bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-0.5">
              {log.map((line, i) => (
                <div key={i} className={line.startsWith("✗") ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}>
                  {line}
                </div>
              ))}
            </div>

            {progress.finished && (
              <div className="mt-4 flex justify-end gap-3">
                <button
                  onClick={() => { reset(); onClose(); }}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}

        {importing && !progress?.finished && (
          <div className="flex items-center gap-2 mt-3 text-sm text-gray-500 dark:text-gray-400">
            <span className="w-4 h-4 border-2 border-gray-300 border-t-green-600 rounded-full animate-spin" />
            Importing…
          </div>
        )}
      </div>
    </div>
  );
}
