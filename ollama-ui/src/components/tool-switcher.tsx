'use client';
import { useToolStore } from '@/store/tools';
import { tools, ToolName } from '@/lib/tools';
import { Button } from './ui/button';
import { useState } from 'react';

export function ToolSwitcher() {
  const { toolSettings, toggleTool } = useToolStore();
  const [showTools, setShowTools] = useState(false);
  const toolNames = Object.keys(tools) as ToolName[];
  const enabledCount = toolNames.filter((name) => toolSettings[name]).length;

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        size="sm"
        variant={showTools ? 'primary' : 'outline'}
        onClick={() => setShowTools((v) => !v)}
        className="flex-1 justify-start gap-2 min-w-[140px]"
      >
        <span>{showTools ? '🔧 Hide tools' : '🔧 Show tools'}</span>
        <span className="ml-auto text-[10px] opacity-80">{showTools ? '▲' : '▼'}</span>
      </Button>
      {showTools && (
        <div className="rounded-md p-3 flex flex-col gap-3 border border-white/15 bg-white/5">
          <div className="flex justify-between items-center">
            <span className="text-[11px] font-medium text-indigo-200/80">
              Tools ({enabledCount} / {toolNames.length} enabled)
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {toolNames.map((toolName) => (
              <label
                key={toolName}
                className="flex items-center gap-2 text-xs p-2 rounded-md bg-white/5 border border-white/10"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-indigo-500 rounded-sm border border-white/30 bg-neutral-900"
                  checked={toolSettings[toolName] ?? false}
                  onChange={() => toggleTool(toolName)}
                />
                <span className="capitalize">{toolName.replace(/_/g, ' ')}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
