import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton, DeviceRowSkeleton } from "../shared/components/Skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Shared/Skeleton",
  component: Skeleton,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Default: Story = {
  args: { className: "h-4 w-48" },
};

export const Title: Story = {
  args: { className: "h-8 w-64" },
};

export const Card: Story = {
  render: () => (
    <div className="bg-white rounded-lg shadow p-6 space-y-4 w-80">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-16" />
    </div>
  ),
};

export const DeviceRow: Story = {
  render: () => (
    <table className="w-full">
      <tbody>
        <DeviceRowSkeleton />
        <DeviceRowSkeleton />
        <DeviceRowSkeleton />
      </tbody>
    </table>
  ),
};
