import { useEffect, useState } from 'react';

export function LocalStorageInfo() {
  const [items, setItems] = useState<Array<{ key: string; value: string }>>([]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('ollama_ui'));
    setItems(keys.map((key) => ({ key, value: localStorage.getItem(key) ?? '' })));
  }, []);
  if (items.length === 0) {
    return (
      <div className="text-xs text-white/40">No Ollama UI settings found in localStorage.</div>
    );
  }
  return (
    <div className="text-xs font-mono text-white/70 flex flex-col gap-2">
      {items.map(({ key, value }) => (
        <div key={key} className="break-all">
          <span className="text-white/40">{key}:</span> <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
