import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta = {
  title: "Tenancy/TenantSwitcher",
  parameters: { layout: "centered" },
  tags: ["autodocs"],
};

export default meta;

export const SingleTenant: StoryObj = {
  render: () => (
    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-50 border border-green-200 rounded-lg">
      <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
      <span className="text-xs font-medium text-green-700">
        11111111-1111-1111-1111
      </span>
    </div>
  ),
};

export const MultiTenant: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4 items-start">
      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-50 border border-green-200 rounded-lg cursor-pointer">
        <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
        <span className="text-xs font-medium text-green-700">Acme Farms</span>
        <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      <div className="w-52 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-100">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Switch Tenant</p>
        </div>
        {["Acme Farms", "Prairie Co", "Sunset Ranch"].map((name, i) => (
          <button key={name} className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left ${i === 0 ? "bg-green-50 text-green-700" : "text-gray-700 hover:bg-gray-50"}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-green-500" : "bg-gray-300"}`} />
            {name}
            {i === 0 && <span className="ml-auto text-green-500">✓</span>}
          </button>
        ))}
      </div>
    </div>
  ),
};
