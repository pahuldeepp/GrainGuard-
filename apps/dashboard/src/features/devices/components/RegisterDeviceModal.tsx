import { useState, useRef, useEffect } from "react";
import { useRegisterDevice } from "../hooks/useRegisterDevice";

// Props received from the parent (DevicesPage)
interface Props {
  open: boolean;           // whether the modal is visible
  onClose: () => void;    // called when user clicks Cancel or the backdrop
  onSuccess: () => void;  // called after a successful registration so DevicesPage can refetch
}

// Serial number must be 4-30 uppercase alphanumeric chars (matching the gateway schema)
// This is the same regex used by the gateway validation middleware (createDeviceSchema)
const SERIAL_RE = /^[A-Z0-9]{4,30}$/;

export function RegisterDeviceModal({ open, onClose, onSuccess }: Props) {
  const [serial, setSerial] = useState("");              // controlled input value
  const [validationError, setValidationError] = useState<string | null>(null); // client-side error
  const inputRef = useRef<HTMLInputElement>(null);       // focus the input when modal opens

  const { loading, error: apiError, register } = useRegisterDevice();

  // Auto-focus the serial input whenever the modal opens
  useEffect(() => {
    if (open) {
      setSerial("");                   // reset field on each open
      setValidationError(null);
      setTimeout(() => inputRef.current?.focus(), 50); // after CSS transition
    }
  }, [open]);

  // Keyboard: close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();                  // prevent page reload

    // Client-side validation before hitting the network
    const trimmed = serial.trim().toUpperCase();
    if (!SERIAL_RE.test(trimmed)) {
      setValidationError(
        "Serial number must be 4–30 uppercase letters or digits (e.g. SN12345678)"
      );
      return;
    }
    setValidationError(null);

    const result = await register(trimmed); // POST /devices

    if (result) {
      // Success — DevicesPage will refetch the device list
      onSuccess();
      onClose();
    }
    // If result is null, useRegisterDevice already set apiError — it shows below the input
  }

  if (!open) return null;  // completely unmount when closed (no hidden DOM node)

  return (
    // Semi-transparent backdrop — clicking it closes the modal
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="register-device-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal panel */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <h2
          id="register-device-title"
          className="text-lg font-bold text-gray-900 dark:text-white mb-1"
        >
          Register a Device
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Enter the serial number printed on the device label.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label
            htmlFor="serial-input"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Serial Number
          </label>
          <input
            id="serial-input"
            ref={inputRef}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={serial}
            onChange={(e) => {
              setSerial(e.target.value.toUpperCase()); // normalise to uppercase as user types
              setValidationError(null);                // clear error on each keystroke
            }}
            placeholder="e.g. SN00123456"
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700
                       bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                       rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500
                       focus:border-transparent font-mono"
          />

          {/* Show client-side OR server-side error — never both */}
          {(validationError ?? apiError) && (
            <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
              {validationError ?? apiError}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}            // prevent closing while request is in-flight
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300
                         border border-gray-300 dark:border-gray-700 rounded-lg
                         hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || serial.trim().length < 4}  // disable if too short
              className="px-4 py-2 text-sm text-white bg-green-600 rounded-lg
                         hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed
                         flex items-center gap-2"
            >
              {loading && (
                // Simple CSS spinner — no extra library needed
                <span className="w-4 h-4 border-2 border-white/30 border-t-white
                                 rounded-full animate-spin" />
              )}
              {loading ? "Registering…" : "Register Device"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
