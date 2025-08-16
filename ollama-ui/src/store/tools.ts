import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ToolName, tools } from '@/lib/tools';

// All tools are enabled by default
const defaultToolSettings = Object.keys(tools).reduce(
  (acc, toolName) => {
    acc[toolName as ToolName] = true;
    return acc;
  },
  {} as Record<ToolName, boolean>,
);

interface ToolState {
  toolSettings: Record<ToolName, boolean>;
  toggleTool: (toolName: ToolName) => void;
  setToolEnabled: (toolName: ToolName, enabled: boolean) => void;
}

const useToolStore = create<ToolState>()(
  persist(
    (set) => ({
      toolSettings: defaultToolSettings,
      toggleTool: (toolName) =>
        set((state) => ({
          toolSettings: {
            ...state.toolSettings,
            [toolName]: !state.toolSettings[toolName],
          },
        })),
      setToolEnabled: (toolName, enabled) =>
        set((state) => ({
          toolSettings: {
            ...state.toolSettings,
            [toolName]: enabled,
          },
        })),
    }),
    {
      name: 'ollama-ui-tool-storage',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export { useToolStore };
