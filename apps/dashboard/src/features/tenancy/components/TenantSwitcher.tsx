import { useState, useRef, useEffect } from "react";
import { useTenantContext } from "../TenantContext";

export function TenantSwitcher() {
  const { activeTenantId, availableTenants, setActiveTenant } = useTenantContext();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!activeTenantId) return null;

  // Single tenant — show badge only, no dropdown needed
  if (availableTenants.length <= 1) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
        <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
        <span className="text-xs font-medium text-green-700 dark:text-green-400 max-w-[120px] truncate">
          {activeTenantId}
        </span>
      </div>
    );
  }

  // Multi-tenant — show switcher dropdown
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Current tenant: ${activeTenantId}. Click to switch.`}
        className="flex items-center gap-1.5 px-2.5 py-1 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors"
      >
        <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
        <span className="text-xs font-medium text-green-700 dark:text-green-400 max-w-[120px] truncate">
          {activeTenantId}
        </span>
        <svg
          className={`w-3 h-3 text-green-600 dark:text-green-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label="Select tenant"
          className="absolute right-0 mt-1 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wide">
              Switch Tenant
            </p>
          </div>
          {availableTenants.map((tenantId) => (
            <button
              key={tenantId}
              role="option"
              aria-selected={tenantId === activeTenantId}
              onClick={() => {
                setActiveTenant(tenantId);
                setIsOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors
                ${tenantId === activeTenantId
                  ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                  : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
            >
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                tenantId === activeTenantId ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"
              }`} />
              <span className="truncate">{tenantId}</span>
              {tenantId === activeTenantId && (
                <svg className="w-3.5 h-3.5 ml-auto text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
