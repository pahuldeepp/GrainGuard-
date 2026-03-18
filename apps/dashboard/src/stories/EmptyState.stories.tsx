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
  args: { icon: "📭", title: "No items found", description: "Nothing here yet." },
};

export const WithAction: Story = {
  args: {
    icon: "🌾",
    title: "No devices found",
    description: "Devices will appear once they connect.",
    action: { label: "Refresh", onClick: () => {} },
  },
};

export const Error: Story = {
  args: {
    icon: "⚠️",
    title: "Failed to load",
    description: "Connection timed out.",
    action: { label: "Retry", onClick: () => {} },
  },
};
