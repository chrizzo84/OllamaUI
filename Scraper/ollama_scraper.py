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
	for a in soup.select('a.group.w-full'):
		slug_el = a.select_one('[x-test-search-response-title]')
		if not slug_el:
			continue
		slug = slug_el.get_text(strip=True).lower()
		
		# Pulls
		pulls_el = a.select_one('[x-test-pull-count]')
		pulls_val = None
		pulls_text = None
		if pulls_el:
			pulls_text_raw = pulls_el.get_text(strip=True)
			pulls_text = f"{pulls_text_raw} Pulls"
			match = re.search(r"([0-9]+(?:\.[0-9]+)?)([KMB])?", pulls_text_raw, re.IGNORECASE)
			if match:
				num = float(match.group(1))
				abbr = match.group(2)
				if abbr:
					num *= NUM_ABBR.get(abbr.upper(), 1)
				pulls_val = int(num)

		# Blurb - try to get the description paragraph
		blurb_el = a.select_one('p.line-clamp-2') or a.select_one('p')
		blurb = ' '.join(blurb_el.get_text(' ').split()) if blurb_el else None
		
		# Capabilities from the small tags
		capabilities = sorted({w.get_text(strip=True).lower() for w in a.select('span[class*="bg-"]') if w.get_text(strip=True).lower() in CAPABILITY_KEYWORDS})

		out.append({
			'slug': slug,
			'capabilities': list(capabilities),
			'pulls': pulls_val,
			'pulls_text': pulls_text,
			'blurb': blurb,
		})
	return out

def parse_library(html: str, model: Dict[str, Any]) -> None:
	soup = BeautifulSoup(html, 'lxml')
	# Try to find a more robust title
	title_el = soup.select_one('h1') or soup.find(['h1','h2'])
	if title_el:
		model['name'] = ' '.join(title_el.get_text(' ').split())
	
	# Refine pulls/downloads from the library page if search missed it
	text_all = soup.get_text(' ')
	if not model.get('pulls'):
		dl_match = re.search(r"([0-9]+(?:\.[0-9]+)?)([KMB])?\s*(?:Pulls|Downloads)", text_all, re.IGNORECASE)
		if dl_match:
			num = float(dl_match.group(1))
			abbr = dl_match.group(2)
			if abbr:
				num *= NUM_ABBR.get(abbr.upper(), 1)
			model['pulls'] = int(num)
			model['pulls_text'] = dl_match.group(0)

	# Update capabilities from chips on the page
	caps_found = set(model.get('capabilities', []))
	# Look for specific chip-like elements that contain keywords
	for chip in soup.select('span, div'):
		txt = chip.get_text(strip=True).lower()
		if txt in CAPABILITY_KEYWORDS:
			caps_found.add(txt)
	model['capabilities'] = sorted(caps_found)

	# Readme/Description
	readme = soup.find(id=re.compile('readme', re.IGNORECASE))
	if readme:
		# Exclude the "Readme" header if it's there
		desc_text = readme.get_text(' ')
		model['description'] = ' '.join(desc_text.split())[:3000]
	else:
		meta = soup.find('meta', attrs={'name':'description'})
		if meta and meta.get('content'):
			model['description'] = meta['content'][:3000]

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
		base_models = []
		page = 1
		while True:
			url = f"{SEARCH_URL}?page={page}"
			console.log(f"Fetching search page {page}...")
			html = await fetch(client, url)
			page_models = parse_search(html)
			if not page_models:
				break
			
			# Filter out duplicates if any
			for m in page_models:
				if not any(existing['slug'] == m['slug'] for existing in base_models):
					base_models.append(m)
			
			if limit and len(base_models) >= limit:
				base_models = base_models[:limit]
				break
				
			page += 1
			# Safety break to avoid infinite loops if the site changes
			if page > 100:
				break

		console.log(f"Discovered {len(base_models)} model slugs across {page-1} pages")
		results: List[Dict[str, Any]] = []
		sem = asyncio.Semaphore(6)
		progress = Progress(SpinnerColumn(), *Progress.get_default_columns(), TimeElapsedColumn(), transient=True)
		task_id = progress.add_task("Scraping model details", total=len(base_models))
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
