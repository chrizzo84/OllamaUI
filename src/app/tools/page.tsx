'use client';
import { useState, useRef } from 'react';
import { useToolsStore } from '@/store/tools';
import { Button } from '@/components/ui/button';
import Ajv, { type ErrorObject } from 'ajv';
import { useSearxngConfig } from '@/store/searxng';

const ajv = new Ajv({ allErrors: true, strict: false });

const TEMPLATES: Array<{
  name: string;
  label: string;
  description: string;
  schema: unknown;
}> = [
  {
    name: 'web_search',
    label: 'SearXNG Search',
    description:
      'Nutze SearXNG Metasuche. Gib die SERP Resultate strukturiert (Titel, URL, Snippet) wieder und ziehe daraus relevante Fakten.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriffe oder Frage' },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 15,
          default: 5,
          description: 'Maximale Anzahl Resultate (1-15)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    label: 'Fetch URL',
    description: 'Hole den reinen Text-Inhalt einer URL.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Ziel URL' },
        max_chars: {
          type: 'integer',
          minimum: 100,
          maximum: 100000,
          default: 8000,
          description: 'Truncate an dieser Länge',
        },
      },
      required: ['url'],
    },
  },
];

export default function ToolsPage() {
  const tools = useToolsStore((s) => s.tools);
  const add = useToolsStore((s) => s.add);
  const remove = useToolsStore((s) => s.remove);
  const toggle = useToolsStore((s) => s.toggle);

  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftSchema, setDraftSchema] = useState(
    () => `{
  "type": "object",
  "properties": {
    "example": { "type": "string" }
  },
  "required": ["example"]
}`,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [schemaErrors, setSchemaErrors] = useState<string[]>([]);

  function addTool() {
    if (!draftName.trim()) return;
    add({
      name: draftName.trim(),
      description: draftDesc.trim(),
      schemaText: draftSchema,
      enabled: true,
    });
    setDraftName('');
    setDraftDesc('');
  }

  function isValidJSON(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  function validateSchema() {
    setSchemaErrors([]);
    if (!isValidJSON(draftSchema)) return false;
    try {
      const parsed = JSON.parse(draftSchema);
      const valid = ajv.validateSchema(parsed);
      if (!valid) {
        setSchemaErrors(
          (ajv.errors || []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message || ''}`),
        );
      }
      return !!valid;
    } catch (e) {
      setSchemaErrors(['Parsing Fehler: ' + (e as Error).message]);
      return false;
    }
  }

  function applyTemplate(name: string) {
    const t = TEMPLATES.find((x) => x.name === name);
    if (!t) return;
    setDraftName(t.name);
    setDraftDesc(t.description);
    setDraftSchema(JSON.stringify(t.schema, null, 2));
    validateSchema();
  }

  function exportTools() {
    const blob = new Blob([JSON.stringify(tools, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tools-export.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  interface ImportedToolLike {
    name?: string;
    description?: string;
    schema?: unknown;
    parameters?: unknown;
    jsonSchema?: unknown;
  }
  function importTools(list: unknown) {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as ImportedToolLike;
      const name = item.name?.trim();
      if (!name) continue;
      const schemaCandidate = item.schema || item.parameters || item.jsonSchema;
      if (!schemaCandidate || typeof schemaCandidate !== 'object') continue;
      try {
        const schemaText = JSON.stringify(schemaCandidate, null, 2);
        add({ name, description: item.description || '', schemaText, enabled: true });
      } catch {
        // ignore serialization failures
      }
    }
  }

  function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        importTools(json);
      } catch {
        // ignore
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-12 flex flex-col gap-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Tools
        </h1>
        <p className="text-white/50 text-sm mt-2">
          Definiere funktionale Tools (Function Calling) die der LLM nutzen darf.
        </p>
      </header>
      <HostConfig />
      <section className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-4 p-4 rounded-lg border border-white/10 bg-white/5">
          <h2 className="text-sm font-semibold text-white/80">Neues Tool</h2>
          <div className="flex flex-wrap gap-2 mb-1">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.name}
                onClick={() => applyTemplate(t.name)}
                className="text-[10px] rounded border border-white/15 px-2 py-1 text-white/60 hover:text-white hover:border-white/40 transition"
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            className="rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            placeholder="Name (snake_case)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
          />
          <input
            className="rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            placeholder="Beschreibung"
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
          />
          <textarea
            className={`min-h-[180px] font-mono text-xs rounded-md border bg-white/10 px-3 py-2 text-white/80 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${isValidJSON(draftSchema) ? 'border-white/15' : 'border-red-500/40 ring-red-500/30'}`}
            value={draftSchema}
            onChange={(e) => {
              setDraftSchema(e.target.value);
              // live validation (debounced could be nicer)
              validateSchema();
            }}
          />
          {schemaErrors.length > 0 && (
            <div className="rounded bg-red-500/10 border border-red-500/30 p-2 text-[10px] leading-relaxed text-red-200/80 space-y-0.5 max-h-32 overflow-auto">
              {schemaErrors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              disabled={!draftName.trim() || !isValidJSON(draftSchema) || schemaErrors.length > 0}
              onClick={() => {
                if (!validateSchema()) return;
                addTool();
              }}
            >
              Tool hinzufügen
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                validateSchema();
              }}
            >
              Validieren
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraftName('');
                setDraftDesc('');
                setDraftSchema('');
                setSchemaErrors([]);
              }}
            >
              Reset
            </Button>
          </div>
          <div className="flex gap-2 mt-2">
            <Button size="sm" variant="outline" onClick={exportTools}>
              Export
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              onChange={onImportFile}
              className="hidden"
            />
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
              Import
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-white/80">Aktive Tools</h2>
          {tools.length === 0 && (
            <div className="text-xs text-white/40">Keine Tools definiert.</div>
          )}
          <ul className="space-y-3">
            {tools.map((t) => (
              <li
                key={t.id}
                className="rounded-md border border-white/10 bg-white/5 p-3 flex flex-col gap-2"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggle(t.id)}
                    className={`h-4 w-4 rounded-sm border flex items-center justify-center text-[10px] ${t.enabled ? 'bg-gradient-to-br from-indigo-500 to-pink-500 border-indigo-400 text-white' : 'border-white/30 text-white/40'}`}
                    aria-pressed={t.enabled}
                  >
                    {t.enabled ? '✓' : ''}
                  </button>
                  <span className="font-medium text-white/90 text-sm">{t.name}</span>
                  <span className="ml-auto text-[10px] text-white/40">
                    {new Date(t.updatedAt).toLocaleTimeString()}
                  </span>
                </div>
                {t.description && (
                  <p className="text-[11px] text-white/50 leading-relaxed">{t.description}</p>
                )}
                <details className="group">
                  <summary className="cursor-pointer text-[11px] text-white/40 group-open:text-white/60">
                    Schema
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-relaxed text-white/70">
                    {t.schemaText}
                  </pre>
                </details>
                <div className="flex gap-2 mt-1">
                  <Button size="sm" variant="outline" onClick={() => toggle(t.id)}>
                    {t.enabled ? 'Deaktivieren' : 'Aktivieren'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => remove(t.id)}
                    className="text-red-300 hover:text-red-200 hover:border-red-400/50 border-red-400/30"
                  >
                    Löschen
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function HostConfig() {
  const {
    endpointTemplate,
    defaultMaxResults,
    concurrency,
    includeDomains,
    excludeDomains,
    update,
  } = useSearxngConfig();
  const [localEndpoint, setLocalEndpoint] = useState(endpointTemplate);
  const [localMax, setLocalMax] = useState(defaultMaxResults.toString());
  const [localConc, setLocalConc] = useState(concurrency.toString());
  const [localInclude, setLocalInclude] = useState(includeDomains);
  const [localExclude, setLocalExclude] = useState(excludeDomains);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const max = Math.min(Math.max(parseInt(localMax, 10) || 1, 1), 50);
    const conc = Math.min(Math.max(parseInt(localConc, 10) || 1, 1), 5);
    update({
      endpointTemplate: localEndpoint.trim(),
      defaultMaxResults: max,
      concurrency: conc,
      includeDomains: localInclude.trim(),
      excludeDomains: localExclude.trim(),
    });
    setMsg('Gespeichert');
    setTimeout(() => setMsg(null), 2000);
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-3 max-w-xl">
      <h2 className="text-sm font-semibold text-white/80">SearXNG Konfiguration (einfach)</h2>
      <p className="text-[11px] text-white/40 leading-relaxed">
        Nutze Platzhalter &lt;query&gt; in der Endpoint URL. Beispiel:
        http://192.168.188.57:8880/search?q=&lt;query&gt;&amp;format=json
      </p>
      <input
        value={localEndpoint}
        onChange={(e) => setLocalEndpoint(e.target.value)}
        placeholder="http://host:8880/search?q=<query>&format=json"
        className="rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
      />
      <div className="flex gap-3">
        <div className="flex flex-col gap-1 w-32">
          <label className="text-[10px] uppercase tracking-wide text-white/40">Max Results</label>
          <input
            value={localMax}
            onChange={(e) => setLocalMax(e.target.value)}
            type="number"
            min={1}
            max={50}
            className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
        </div>
        <div className="flex flex-col gap-1 w-36">
          <label className="text-[10px] uppercase tracking-wide text-white/40">Concurrency</label>
          <input
            value={localConc}
            onChange={(e) => setLocalConc(e.target.value)}
            type="number"
            min={1}
            max={5}
            className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
        </div>
      </div>
      <div className="flex gap-3">
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-[10px] uppercase tracking-wide text-white/40">
            Include Domains (comma)
          </label>
          <input
            value={localInclude}
            onChange={(e) => setLocalInclude(e.target.value)}
            placeholder="example.com,heise.de"
            className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-[10px] uppercase tracking-wide text-white/40">
            Exclude Domains (comma)
          </label>
          <input
            value={localExclude}
            onChange={(e) => setLocalExclude(e.target.value)}
            placeholder="twitter.com"
            className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
        </div>
      </div>
      <div className="flex gap-2 items-center">
        <Button size="sm" disabled={!localEndpoint.trim()} onClick={save}>
          Speichern
        </Button>
        {msg && <span className="text-[11px] text-white/50">{msg}</span>}
      </div>
    </div>
  );
}
