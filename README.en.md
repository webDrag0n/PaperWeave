<div align="center">

<img src="README.assets/logo.png" alt="PaperWeave Logo" width="128">

# PaperWeave

**A lightweight, cross-platform desktop paper reader: read, annotate, rate — and weave your library into an explorable 3D citation network.**

[中文文档](README.md)

[![Version](https://img.shields.io/badge/version-1.0.0-4aa3ff)](release/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-b678ff)](#-download)
[![Electron](https://img.shields.io/badge/Electron-33-5b6270)](package.json)
[![Tests](https://img.shields.io/badge/tests-161%20%2B%2047%20%2B%2049%20passing-7bf1a8)](#-testing--quality)

![3D citation graph](README.assets/graph.png)

[Download](#-download) · [Quick start](#-quick-start) · [Features](#-features) · [Agent integration](#-agent-integration) · [Development](#-development)

</div>

---

## 📖 Contents

- [Introduction](#-introduction)
- [Features](#-features)
- [Download](#-download)
- [Quick start](#-quick-start)
- [Typical workflow](#-typical-workflow)
- [Agent integration](#-agent-integration)
- [Testing & quality](#-testing--quality)
- [Packaging](#-packaging)
- [Data & privacy](#-data--privacy)
- [Architecture](#-architecture)
- [FAQ](#-faq)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

## 💡 Introduction

PaperWeave is built for "reading papers + mapping the field". It is more than a PDF reader: imported papers get their citation relations resolved automatically, weaving your library into an interactive 3D citation network. References that are not yet in your library can be downloaded and linked with one click.

One codebase builds for Windows / macOS / Linux. The frontend is plain ES modules with no build step, and agents can take full control of the library via a local HTTP API or the bundled MCP server.

**界面语言 / UI language**: the app UI switches between Chinese and English (🌐 button in the top bar, preference persisted).

## ✨ Features

### 📄 Reading & annotation

- **PDF reading**: multi-page rendering, lazy rendering for long documents, Ctrl+wheel zoom, ↔ fit-width, ← → page navigation, text selection & copy
- **Outline sidebar**: a slim left rail expands into a translucent outline panel; clicking an entry **jumps precisely to the section heading** (outline dest coordinates + title-text-line fallback)
- **Highlights**: popup toolbar on selection, 5 colors, optional text comments; "📌 Sticky notes" can be placed anywhere on a page
- **Notes**: per-paper Markdown notes with edit/preview toggle and auto-save
- **Reading experience**: per-paper reading position memory (restored on reopen); collapsible side panel for focus reading; 🌙 eye-care mode; ☀️ light / dark themes (graph palette follows the theme)

![Reader](README.assets/02-reader.png)

### ⭐ Library management

- **Multiple libraries**: a collapsible left panel manages libraries as cards — name & description (click ✎ to edit inline), ★ pin to top, drag to reorder, delete requires typing the full name to confirm; the initial default library is always named `New Graph`
- **Unified import**: one "📥 Import" modal handles pasted links (direct PDF / arXiv), drag-and-drop files, and click-to-browse multi-select
- **One unified paper store**: each paper is stored once globally (same id reused across libraries); a library only holds paper ids and its own citation links
- **Smart dedupe**: content-hash hits are reused directly; same DOI (possibly different versions) or very similar titles trigger a **confirmation dialog** — reuse the existing paper or import as new
- **Automatic metadata**: title / authors / DOI / abstract / references section extracted on import
- **Importance rating**: 1–5 stars right on the card; manual imports default to 1 star, citation-downloaded papers default to unrated
- **Rating sections & sorting**: grouped by rating by default (★★★★★ → ☆ unrated); sortable by recency / year / title / link count
- Search, tags, favorites, bulk management; **titles support inline Markdown** (`**bold**`, `*italic*`, `` `code` ``, `~~strike~~`)

![Library](README.assets/01-library.png)
![Light theme](README.assets/06-light-theme.png)

### 🌐 3D citation graph

- Force-directed 3D graph; all paper labels always visible (inline-Markdown aware); node glow; smooth camera transitions
- **Hop-depth slider** (1–5, default 2): 🟡 selected paper, neighbors colored per hop (blue/orange/purple/green/pink), nodes beyond N hops stay gray
- **Shift+click multi-select**: shortest paths between the selected papers are outlined with rings and bright lines (without overriding hop colors); hop distance is measured from the nearest selected node
- Filter nodes by rating (all / ≥N stars / 5 only); enter from the library toolbar / reader toolbar / card "Graph" button — exiting returns to where you came from (Esc works too)
- Drag to rotate · scroll to zoom · click to select · double-click to open

### 🔗 Citation engine

- **Resolve on import**: every imported/downloaded paper gets its citation relations resolved automatically in the background
- **Fetch references**: prefers Semantic Scholar's structured references (paginated, most accurate); falls back to parsing the PDF references section (`[1]` / `1.` / `[Vaswani+17]` / unnumbered lists, deduplicated), resolving each entry via DOI (CrossRef) / arXiv / S2 title match / OpenAlex
- **Fetch citations**: Semantic Scholar (throttled with backoff), automatic OpenAlex fallback with pagination
- **Not-in-library loop**: resolved-but-absent entries are persisted in the "Refs" panel — **download individually or all at once** (arXiv / OpenAlex open access), auto-linked on import and shown in the graph; background downloads never block reading
- 🧩 Offline fuzzy matching (no network) and ➕ manual linking as fallbacks

### 🧭 Similarity & discovery

- **Similar papers**: bibliographic coupling (shared references) × co-citation (shared citers) compute in-library similarity; selecting a paper shows its Top 5 similar papers with overlap percentages in the detail panel — click to jump
- **Discover beyond the library**: the "🧭 Discover" button on the library toolbar aggregates reference/citation overlap across the whole library — "🏛 Prior works" lists foundational papers co-cited by multiple library papers but not yet imported; "🌱 Derivative works" lists new papers citing multiple library papers — each downloadable into the library in one click

![Discover](README.assets/08-discover.png)

## 📦 Download

Pre-built artifacts live in [`release/`](release/) (currently v1.0.0):

| File | Platform | Notes |
| --- | --- | --- |
| `PaperWeave-1.0.0-win-x64-setup.exe` | Windows | NSIS installer (custom install dir) |
| `PaperWeave-1.0.0-win-x64-portable.exe` | Windows | Portable, no installation required |
| `PaperWeave-1.0.0-linux-x64.zip` | Linux | Unzip and run `PaperWeave` |

For macOS, build from source (see [Packaging](#-packaging)).

## 🚀 Quick start

### Pre-built

1. Download and run the installer or portable build for your platform
2. Drag PDFs into the window, or use "🔗 Import by URL" with an arXiv link
3. Open a paper to read; click "🌐" to enter the citation graph

### From source

```bash
git clone <repo-url> && cd PaperWeave
npm install          # Electron, pdf.js, three.js
npm start            # Desktop app (Electron)
npm run dev          # Browser preview at http://localhost:7100/ (sample data auto-loaded)
```

## 🧭 Typical workflow

1. **Build the library**: drag in PDFs (or paste arXiv links) — metadata and citation links resolve automatically
2. **Deep read**: outline sidebar jumps → highlight key sentences → sticky notes for questions → Markdown notes for summaries
3. **Map the field**: card "Graph" → slider for the 2-hop neighborhood → Shift-select core papers to see shortest paths → one-click download of high-impact references not yet in the library
4. **Triage**: rate papers with stars; the library groups by rating and the graph filters by it

## 🤖 Agent integration

PaperWeave offers two agent interfaces (see [`agents/AGENTS.md`](agents/AGENTS.md), API v3):

- **Local HTTP Agent API** (`127.0.0.1:24680`, `X-PaperWeave-Token` auth): library management, import, annotations, notes, citation fetch & download, graph snapshot, live progress polling
- **MCP stdio server** (`mcp/paperweave-mcp.js`, zero-dependency single file): works with Claude Desktop / Cursor / Kimi etc.; 20 tools mirroring the HTTP API, plus 5 resources and 3 prompt workflow templates (deep-read / survey / import-and-link)

```jsonc
// MCP host configuration example
{
  "mcpServers": {
    "paperweave": { "command": "node", "args": ["<absolute path to paperweave-mcp.js>"] }
  }
}
```

Connection info (port + token) is written to `paperweave-data/agent-api.json` on startup; portable builds also write it next to the exe, along with copies of `AGENTS.md` and `paperweave-mcp.js`.

## 🧪 Testing & quality

Three full regression suites covering real user paths, API contracts and the MCP protocol:

```bash
npm run selftest     # End-to-end: 161 user scenarios (real Electron rendering + screenshot archive)
npm run apitest      # Agent HTTP API: 47 endpoint scenarios
npm run mcptest      # MCP server: 49 stdio scenarios
```

- Coverage: import dedupe, metadata extraction, lazy rendering, highlight overlap guard, notes, rating sections & sorting, hop coloring, multi-select shortest paths, outline sidebar, reading-position memory, citation fetch & download loop, i18n toggle, and more
- Screenshots are archived to `shots/`; the report lands in `selftest-report.json`

### Development conventions (required)

> **Every feature / API change must update `agents/AGENTS.md` in sync**: document new or modified endpoints, data fields and semantics, and bump the API version. Packaging (`extraResources`) ships the latest document to end users. Update the cases in `tools/api-test.js` / `tools/mcp-test.js` accordingly and run `npm run apitest` and `npm run mcptest`.

## 📦 Packaging

One codebase, three platforms:

```bash
npm run dist:win     # Windows: NSIS installer + portable exe
npm run dist:linux   # Linux: AppImage / deb (run on Linux; cross-build zip works on Windows)
npm run dist:mac     # macOS: dmg / zip (must run on macOS, electron-builder limitation)
```

> **Build tip**: in a Kimi/Electron-hosted terminal, `ELECTRON_RUN_AS_NODE=1` breaks asar packaging — use the bundled standalone Node: `tools/runtime/node-v24.21.0-win-x64/node.exe tools/build.js --win`. If a workspace file watcher holds `app.asar`, add `-c.directories.output=<system temp dir>` and move the artifacts back afterwards.

## 🗂 Data & privacy

- **Fully local-first**: library, annotations, notes and ratings stay on your machine; no telemetry, no cloud sync
- Desktop data lives in `paperweave/paperweave-data/` under the user-data directory:
  - `data.json` app config & library list; `papers.json` global paper registry; `annotations.json` annotations
  - `libraries/<id>.json` per-library paper ids & citation links; `library/` shared PDF store (content-hash named)
  - Windows: `C:\Users\<you>\AppData\Roaming\paperweave\paperweave-data\`
  - macOS: `~/Library/Application Support/paperweave/paperweave-data/`
  - Linux: `~/.config/paperweave/paperweave-data/`
- Browser preview uses localStorage + IndexedDB
- Citation fetching only talks to public scholarly APIs (Semantic Scholar / OpenAlex / CrossRef / arXiv)

## 🏗 Architecture

```
main/       Electron main process: window, import, download, metadata extraction,
            citation engine, JSON store, Agent HTTP API
  ├─ service.js     Business service layer (shared by IPC and the Agent API)
  ├─ refs.js        Citation engine: S2/OpenAlex/CrossRef/arXiv, throttling, backoff
  └─ agent-api.js   Local HTTP interface (127.0.0.1 + X-PaperWeave-Token)
preload/    Controlled IPC bridge
renderer/   Plain ES-module frontend (no build step): library / reader / 3D graph / notes
agents/     AGENTS.md (Agent API contract, shipped with the app)
mcp/        paperweave-mcp.js (zero-dependency MCP stdio server)
vendor/     pdf.js and three.js static files (loaded via importmap)
tools/      Dev server, test runners (selftest / apitest / mcptest), packaging wrapper, sample PDF generator
```

- PDF rendering: pdf.js (text layer selection + custom highlight layer)
- 3D graph: three.js + hand-rolled force layout + OrbitControls
- Storage: atomic JSON writes (auto-backup on corruption), PDFs deduped by content hash

## ❓ FAQ

**Rate limited while fetching citations?**
Semantic Scholar's unauthenticated quota is a shared pool (~1 req/s) and may 429 at peak times. The app throttles and backs off automatically, falling back to OpenAlex. For a stable quota, set `PAPERWEAVE_S2_API_KEY=<your S2 API key>` before launching (free from Semantic Scholar).

**Don't want auto citation resolution on import?**
Start with `PAPERWEAVE_AUTOFETCH=0`; manual fetch remains available in the "Refs" tab.

**A reference fails to download?**
Downloads use arXiv direct links and OpenAlex open-access locations; paywalled papers without OA sources are reported as failed — download manually, import, then click "In library · Link" to connect them.

**macOS / Linux installers?**
macOS builds must run `npm run dist:mac` on macOS; AppImage/deb must run `npm run dist:linux` on Linux (Windows can only cross-build the zip).

## 🗺 Roadmap

- [ ] Signed & notarized macOS builds
- [ ] Export highlights and notes to Markdown / BibTeX
- [ ] Zotero library import
- [ ] Cross-library full-text search
- [ ] Citation network timeline view (by publication year)
- [ ] S2 API key settings UI

## 🤝 Contributing

Issues and PRs are welcome. Before submitting code:

1. Run `npm run selftest && npm run apitest && npm run mcptest` — all three suites must pass
2. Follow the [development conventions](#-testing--quality) and keep `agents/AGENTS.md` in sync

## 📄 License

[MIT](LICENSE) © PaperWeave
