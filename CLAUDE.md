# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome browser extension called "IMDB W2W: IMDB Where to Watch" that enhances IMDB pages by displaying streaming service information. When users hover over movie titles on IMDB, the extension shows available streaming options with prices and provider icons via a floating popup.

## Development Workflow

### Loading the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in top right
3. Click "Load unpacked" and select this project directory
4. Test on IMDB pages (Top 250, charts, movie lists)

### Debugging
- **Content Script**: Use Chrome DevTools on IMDB pages, check Console for logs
- **Service Worker**: In Chrome Extensions page, click "service worker" link to open dedicated DevTools
- **Permissions Issues**: Check that `host_permissions` include IMDB and JustWatch domains

### Testing URLs
- IMDB Top 250: `https://www.imdb.com/chart/top/`
- Any IMDB movie list page with `.ipc-metadata-list-summary-item` elements

## Architecture

### Core Components

- **manifest.json**: Chrome extension configuration with permissions for IMDB and JustWatch domains
- **scripts/content.js**: Content script that runs on IMDB pages, handles UI interactions and hover events
- **scripts/scrape.js**: Background service worker that fetches and parses streaming data from JustWatch
- **jw_sample_page.html**: Sample JustWatch page used for testing/development (fallback when fetch fails)
- **lib/**: Vendored dependencies for HTML parsing and text entity handling
  - parse5.min.js: HTML parser for processing JustWatch pages
  - entities_decode/escape.min.js: Text entity handling utilities

### Data Flow

1. User hovers over movie title on IMDB page
2. Content script extracts movie title and year, establishes persistent port connection to background script
3. Background script fetches JustWatch data (falls back to sample file if live fetch fails)
4. Background script parses HTML using parse5 and extracts streaming offers by category
5. Content script receives offer data and updates global popup with provider icons and pricing
6. Popup displays streaming options organized by categories: stream, rent, buy

### Key Architecture Patterns

- **Global Popup Reuse**: Single popup element reused across all hover events for performance
- **Persistent Port Connection**: Uses `chrome.runtime.connect()` for efficient message passing
- **Smart Positioning**: Popup aligns based on viewport constraints (top/bottom half of screen)
- **Fallback Strategy**: Gracefully degrades to sample data when JustWatch API fails
- **Inline CSS Styling**: Avoids CSP issues with content scripts

### Critical Selectors (Brittle Dependencies)

- **IMDB Targets**: `.ipc-metadata-list-summary-item` (movie entries), `.ipc-title__text` (titles), `.cli-title-metadata-item` (years)
- **JustWatch Parsing**: `.buybox-row ${categoryName} inline`, `.buybox-row__offers`, `a` (offer links)
- **Service Icons**: Fallback icons in `getServiceIcon()` function for major streaming services

### Key Functions

- **extractMovieTitle()**: Parses IMDB DOM to get clean movie title with year
- **showGlobalPopup()**: Manages popup positioning and content loading
- **findOffers()**: HTML parsing logic to extract streaming offers from JustWatch pages
- **adjustPopupPosition()**: Smart positioning based on viewport constraints
- **findTagWithClass()**: Recursive DOM traversal for HTML parsing

## Error Handling

- **Network Failures**: Falls back to `jw_sample_page.html` when JustWatch fetch fails
- **Port Disconnections**: Auto-reconnects when service worker restarts
- **Missing Offers**: Shows "No streaming options available" message
- **Positioning Failures**: Includes viewport boundary checks to prevent popup overflow

## Configuration Notes

- **Manifest V3**: Uses service worker architecture with ES6 modules
- **No Build Process**: Direct file serving, no bundling or compilation
- **CSP Compliant**: Inline styles only, no external CSS files
- **Cross-Origin**: JustWatch requests handled by service worker, not content script