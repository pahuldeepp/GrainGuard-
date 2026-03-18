import type { Meta, StoryObj } from "@storybook/react";
import { EmptyState } from "../shared/components/EmptyState";

const meta: Meta<typeof EmptyState> = {
  title: "Shared/EmptyState",
  component: EmptyState,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  args: {
    icon: "📭",
    title: "No items found",
    description: "Nothing here yet.",
  },
};

export const WithAction: Story = {
  args: {
    icon: "🌾",
    title: "No devices found",
    description: "Devices will appear once they connect and send telemetry.",
    action: { label: "Refresh", onClick: () => alert("Refreshed!") },
  },
};

export const Error: Story = {
  args: {
    icon: "⚠️",
    title: "Failed to load devices",
    description: "Connection timed out. Please try again.",
    action: { label: "Retry", onClick: () => {} },
  },
};

export const NotFound: Story = {
  args: {
    icon: "🔍",
    title: "Device not found",
    description: "This device doesn't exist or you don't have access to it.",
  },
};

export const NoTenant: Story = {
  args: {
    icon: "🏢",
    title: "No tenant assigned",
    description: "Your account is not associated with any tenant.",
  },
};
