#!/usr/bin/env python3
"""Ollama model catalog scraper.

Workflow:
1. Fetch https://ollama.com/search -> extract model slugs + high level capability badges & headline blurb & pulls summary.
2. For each model slug X:
   - Fetch https://ollama.com/library/{slug} -> extract description (Readme intro), total downloads, capability chips (tools / thinking / vision / embedding / etc.).
   - Fetch https://ollama.com/library/{slug}/tags -> extract table rows: tag name, size, context, input type (if present).
3. Aggregate into structured JSON and write to out/ollama_models.json.

Notes:
- We keep network polite (small concurrency) and retry transient failures.
- HTML structure may change; parsing uses defensive heuristics.
- No authentication; only public pages.

Output schema (JSON):
{
  "scraped_at": iso8601,
  "models": [
	 {
	   "slug": str,
	   "name": str,                # Display name if different from slug
	   "pulls": int | null,         # Total downloads (approx numeric) if parseable
	   "pulls_text": str | null,    # Original textual representation
	   "capabilities": [str],       # e.g. ["tools","thinking","vision"]
	   "blurb": str | null,         # Short one-line from search card
	   "description": str | null,   # Longer description/README intro
	   "updated": str | null,       # Relative or absolute text (as shown)
	   "tags_count": int | null,    # Number of tag variants listed on tags page
	   "variants": [
		  {
			"tag": str,             # e.g. "llama3:8b-instruct-q4_0"
			"size_bytes": int | null,
			"size_text": str,       # e.g. "4.7GB"
			"context": str | null,  # e.g. "8K"
			"input": str | null     # e.g. "Text" or other modality
		  }, ...
	   ]
	 }
  ]
}
"""
from __future__ import annotations
import re
import json
import asyncio
import httpx
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential
from typing import List, Dict, Any, Optional
from rich.progress import Progress, SpinnerColumn, TimeElapsedColumn
from rich.console import Console
from rich.table import Table

BASE = "https://ollama.com"
SEARCH_URL = f"{BASE}/search"
LIB_URL = f"{BASE}/library/{{slug}}"
TAGS_URL = f"{BASE}/library/{{slug}}/tags"

console = Console()

CAPABILITY_KEYWORDS = {"tools","thinking","vision","embedding","multimodal","reasoning"}
SIZE_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)([KMG]B)")
PULLS_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)([KMB])?\s*Pulls", re.IGNORECASE)
NUM_ABBR = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}

@retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=0.75, min=0.5, max=6))
async def fetch(client: httpx.AsyncClient, url: str) -> str:
	resp = await client.get(url, timeout=30)
	resp.raise_for_status()
	return resp.text

def parse_search(html: str) -> List[Dict[str, Any]]:
	soup = BeautifulSoup(html, 'lxml')
	out = []
	for a in soup.select('a[href^="/library/"]'):
		href = a.get('href','')
		slug = href.split('/library/')[-1].strip()
		if not slug or '/' in slug:  # skip deeper links
			continue
		if any(m['slug'] == slug for m in out):  # dedupe
			continue
		text = ' '.join(a.get_text(' ').split())
		capabilities = sorted({w.lower() for w in text.split() if w.lower() in CAPABILITY_KEYWORDS})
		pulls_match = PULLS_RE.search(text)
		pulls_val = None
		pulls_text = None
		if pulls_match:
			pulls_text = pulls_match.group(0)
			num = float(pulls_match.group(1))
			abbr = pulls_match.group(2)
			if abbr:
				num *= NUM_ABBR.get(abbr.upper(), 1)
			pulls_val = int(num)
		blurb = text
		if pulls_match:
			blurb = blurb.replace(pulls_match.group(0), '').strip()
		for c in capabilities:
			blurb = re.sub(rf"\b{re.escape(c)}\b", '', blurb, flags=re.IGNORECASE)
		blurb = ' '.join(blurb.split())
		out.append({
			'slug': slug,
			'capabilities': capabilities,
			'pulls': pulls_val,
			'pulls_text': pulls_text,
			'blurb': blurb or None,
		})
	return out

def parse_library(html: str, model: Dict[str, Any]) -> None:
	soup = BeautifulSoup(html, 'lxml')
	title = soup.find(['h1','h2'])
	if title:
		model['name'] = ' '.join(title.get_text(' ').split())
	text_all = soup.get_text(' ')
	dl_match = re.search(r"([0-9]+(?:\.[0-9]+)?)([KMB])?\s*Downloads", text_all, re.IGNORECASE)
	if dl_match:
		num = float(dl_match.group(1))
		abbr = dl_match.group(2)
		if abbr:
			num *= NUM_ABBR.get(abbr.upper(), 1)
		model['pulls'] = int(num)
		model['pulls_text'] = dl_match.group(0)
	caps_found = set(model.get('capabilities', []))
	for kw in CAPABILITY_KEYWORDS:
		if re.search(rf"\b{re.escape(kw)}\b", text_all, re.IGNORECASE):
			caps_found.add(kw)
	model['capabilities'] = sorted(caps_found)
	readme = soup.find(id=re.compile('readme', re.IGNORECASE))
	if readme:
		desc = ' '.join(readme.get_text(' ').split())
		model['description'] = desc[:2000]
	else:
		meta = soup.find('meta', attrs={'name':'description'})
		if meta and meta.get('content'):
			model['description'] = meta['content'][:2000]

def parse_tags(html: str, model: Dict[str, Any]) -> None:
	soup = BeautifulSoup(html, 'lxml')
	variants = []
	for a in soup.select('a[href*=":"]'):
		href = a.get('href','')
		if '/library/' not in href:
			continue
		tag_full = href.split('/library/')[-1]
		if not tag_full.startswith(model['slug'] + ':'):
			continue
		parent_txt = ' '.join(a.parent.get_text(' ').split()) if a.parent else ''
		size_match = SIZE_RE.search(parent_txt)
		size_text = size_match.group(0) if size_match else None
		size_bytes = None
		if size_match:
			num = float(size_match.group(1))
			unit = size_match.group(2)
			mult = {'KB': 1024, 'MB': 1024**2, 'GB': 1024**3}.get(unit.upper(), 1)
			size_bytes = int(num * mult)
		ctx_match = re.search(r"\b(\d+(?:\.?\d+)?K)\b", parent_txt)
		context = ctx_match.group(1) if ctx_match else None
		input_match = re.search(r"\b(Text|Vision|Audio|Image)\b", parent_txt, re.IGNORECASE)
		input_type = input_match.group(1).capitalize() if input_match else None
		variants.append({
			'tag': tag_full,
			'size_text': size_text,
			'size_bytes': size_bytes,
			'context': context,
			'input': input_type,
		})
	seen = set()
	deduped = []
	for v in variants:
		if v['tag'] in seen:
			continue
		seen.add(v['tag'])
		deduped.append(v)
	model['variants'] = deduped
	model['tags_count'] = len(deduped)

async def scrape_model(client: httpx.AsyncClient, base_info: Dict[str, Any]) -> Dict[str, Any]:
	slug = base_info['slug']
	model = dict(base_info)
	try:
		lib_html, tags_html = await asyncio.gather(
			fetch(client, LIB_URL.format(slug=slug)),
			fetch(client, TAGS_URL.format(slug=slug)),
		)
		parse_library(lib_html, model)
		parse_tags(tags_html, model)
	except Exception as e:  # noqa
		model['error'] = str(e)
	return model

async def main(limit: Optional[int] = None, out_path: str = 'out/ollama_models.json'):
	async with httpx.AsyncClient(headers={'User-Agent': 'Mozilla/5.0 (compatible; OllamaScraper/1.0)'}) as client:
		search_html = await fetch(client, SEARCH_URL)
		base_models = parse_search(search_html)
		if limit:
			base_models = base_models[:limit]
		console.log(f"Discovered {len(base_models)} model slugs")
		results: List[Dict[str, Any]] = []
		sem = asyncio.Semaphore(6)
		progress = Progress(SpinnerColumn(), *Progress.get_default_columns(), TimeElapsedColumn(), transient=True)
		task_id = progress.add_task("Scraping models", total=len(base_models))
		progress.start()
		try:
			async def worker(info: Dict[str, Any]):
				async with sem:
					m = await scrape_model(client, info)
					results.append(m)
					progress.advance(task_id)
			await asyncio.gather(*(worker(m) for m in base_models))
		finally:
			progress.stop()
	results.sort(key=lambda x: (-(x.get('pulls') or 0), x['slug']))
	data = {
		'scraped_at': datetime.now(timezone.utc).isoformat(),
		'models': results,
	}
	import os
	os.makedirs(os.path.dirname(out_path), exist_ok=True)
	with open(out_path, 'w', encoding='utf-8') as f:
		json.dump(data, f, ensure_ascii=False, indent=2)
	console.log(f"Wrote {out_path} with {len(results)} models")
	table = Table(title="Ollama Models (top 20 by pulls)")
	table.add_column("Slug")
	table.add_column("Pulls", justify="right")
	table.add_column("Caps")
	table.add_column("Variants", justify="right")
	for m in results[:20]:
		table.add_row(m['slug'], str(m.get('pulls') or ''), ','.join(m.get('capabilities', [])), str(m.get('tags_count') or 0))
	console.print(table)

if __name__ == '__main__':
	import argparse
	p = argparse.ArgumentParser()
	p.add_argument('--limit', type=int, help='Limit number of models for quick test')
	p.add_argument('--out', default='out/ollama_models.json')
	args = p.parse_args()
	asyncio.run(main(limit=args.limit, out_path=args.out))
