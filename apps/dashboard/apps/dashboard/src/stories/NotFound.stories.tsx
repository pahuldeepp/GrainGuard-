import type { Meta, StoryObj } from "@storybook/react";
import { MemoryRouter } from "react-router-dom";
import { NotFound } from "../shared/components/NotFound";

const meta: Meta<typeof NotFound> = {
  title: "Shared/NotFound",
  component: NotFound,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof NotFound>;

export const Default: Story = {};
