import { useState, useEffect, useRef } from "react";
import { useRegisterDevice } from "../hooks/useRegisterDevice";
import toast from "react-hot-toast";

interface Props {
  open: boolean;
  onClose: () => void;
  onRegistered: () => void;
}

const SERIAL_REGEX = /^[A-Za-z0-9\-_]{3,64}$/;

export function RegisterDeviceModal({ open, onClose, onRegistered }: Props) {
  if (!open) return null;

  return (
    <RegisterDeviceModalContent
      onClose={onClose}
      onRegistered={onRegistered}
    />
  );
}

function RegisterDeviceModalContent({ onClose, onRegistered }: Omit<Props, "open">) {
  const [serial, setSerial] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { register, loading, error, reset } = useRegisterDevice();

  useEffect(() => {
    reset();
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(focusTimer);
  }, [reset]);

  const validate = (value: string): string | null => {
    if (!value.trim()) return "Serial number is required";
    if (!SERIAL_REGEX.test(value.trim()))
      return "Only letters, numbers, hyphens and underscores allowed (3–64 chars)";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate(serial);
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    try {
      await register(serial.trim());
      toast.success(`Device "${serial.trim()}" registered successfully`);
      onRegistered();
      onClose();
    } catch {
      // error shown from hook
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKey}
      role="dialog"
      aria-modal="true"
      aria-labelledby="register-modal-title"
    >
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2
            id="register-modal-title"
            className="text-lg font-semibold text-gray-900 dark:text-white"
          >
            Register Device
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

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
            value={serial}
            onChange={(e) => {
              setSerial(e.target.value);
              setValidationError(null);
            }}
            placeholder="e.g. GG-SILO-001"
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 border-gray-300 dark:border-gray-700"
            disabled={loading}
            autoComplete="off"
          />

          {(validationError || error) && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">
              {validationError || error}
            </p>
          )}

          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Found on the device label. Letters, numbers, hyphens and underscores only.
          </p>

          <div className="flex gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !serial.trim()}
              className="flex-1 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Registering...
                </>
              ) : (
                "Register Device"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
