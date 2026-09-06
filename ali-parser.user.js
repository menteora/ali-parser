// ==UserScript==
// @name         Ali Parser - Parsing Tracker
// @namespace    https://github.com/menteora/ali-parser
// @version      0.1.1
// @description  Tiene traccia dei prodotti AliExpress gia aperti/parsati e permette di flaggarli manualmente nelle ricerche.
// @author       menteora
// @updateURL    https://raw.githubusercontent.com/menteora/ali-parser/main/ali-parser.user.js
// @downloadURL  https://raw.githubusercontent.com/menteora/ali-parser/main/ali-parser.user.js
// @match        https://aliexpress.com/*
// @match        https://*.aliexpress.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'ali-parser:products:v1';
  const UI_ATTR = 'data-ali-parser-ui';
  const CARD_ATTR = 'data-ali-parser-product-id';

  const state = {
    currentUrl: location.href,
    observer: null,
    scanTimer: null,
    toolbar: null,
    panel: null,
  };

  function loadRegistry() {
    const value = GM_getValue(STORE_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }

  function saveRegistry(registry) {
    GM_setValue(STORE_KEY, registry);
  }

  function getRecord(productId) {
    return loadRegistry()[productId] || null;
  }

  function patchRecord(productId, patch) {
    const registry = loadRegistry();
    const previous = registry[productId] || { productId };
    const next = {
      ...previous,
      ...patch,
      productId,
      updatedAt: Date.now(),
    };

    registry[productId] = next;
    saveRegistry(registry);
    refreshUi();
    return next;
  }

  function deleteRecord(productId) {
    const registry = loadRegistry();
    delete registry[productId];
    saveRegistry(registry);
    refreshUi();
  }

  function extractProductId(input) {
    if (!input) return null;

    try {
      const url = new URL(input, location.href);
      const pathMatch = url.pathname.match(/\/item\/(\d{8,})\.html/i);
      if (pathMatch) return pathMatch[1];

      const paramId = url.searchParams.get('productId') || url.searchParams.get('product_id');
      if (paramId && /^\d{8,}$/.test(paramId)) return paramId;
    } catch (_) {
      // Fallback sotto.
    }

    const fallback = String(input).match(/(?:\/item\/|productId=|product_id=)(\d{8,})/i);
    return fallback ? fallback[1] : null;
  }

  function canonicalProductUrl(productId) {
    return `${location.origin}/item/${productId}.html`;
  }

  function isProductPage() {
    return Boolean(extractProductId(location.href));
  }

  function recordLabel(record) {
    if (!record) return { text: 'NUOVO', symbol: '○', cls: 'ap-new' };
    if (record.status === 'parsed') return { text: 'PARSATO', symbol: '✓', cls: 'ap-parsed' };
    if (record.status === 'flagged') return { text: 'FLAG', symbol: '⚑', cls: 'ap-flagged' };
    if (record.lastOpenedAt) return { text: 'VISTO', symbol: '●', cls: 'ap-viewed' };
    return { text: 'NUOVO', symbol: '○', cls: 'ap-new' };
  }

  function findCard(anchor) {
    const selectors = [
      '.search-card-item',
      '[class*="search-card"]',
      '[class*="product-card"]',
      '[class*="card-out-wrapper"]',
      '[data-product-id]',
    ];

    for (const selector of selectors) {
      const found = anchor.closest(selector);
      if (found) return found;
    }

    let node = anchor;
    for (let i = 0; i < 7 && node && node !== document.body; i += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 160 && rect.height >= 180) return node;
    }

    return anchor.parentElement;
  }

  function getPrimaryProductAnchor(card, productId) {
    const anchors = card.querySelectorAll('a[href]');
    for (const anchor of anchors) {
      if (extractProductId(anchor.href) === productId) return anchor;
    }
    return null;
  }

  function buildCardControls(card, productId) {
    let controls = card.querySelector(`:scope > [${UI_ATTR}="card-controls"]`);
    if (!controls) {
      controls = document.createElement('div');
      controls.setAttribute(UI_ATTR, 'card-controls');
      controls.className = 'ap-card-controls';
      controls.innerHTML = `
        <button type="button" class="ap-status" title="Stato prodotto"></button>
        <button type="button" class="ap-flag" title="Flag manuale: considera questo articolo gia gestito">⚑</button>
      `;

      const computed = getComputedStyle(card);
      if (computed.position === 'static') card.style.position = 'relative';
      card.appendChild(controls);

      controls.querySelector('.ap-status').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const record = getRecord(productId);
        if (record?.status === 'parsed') {
          const reset = confirm(`Prodotto ${productId} gia parsato. Vuoi azzerare lo stato?`);
          if (reset) deleteRecord(productId);
          return;
        }

        patchRecord(productId, {
          status: 'parsed',
          parsedAt: Date.now(),
          parsedManually: true,
          url: canonicalProductUrl(productId),
        });
      });

      controls.querySelector('.ap-flag').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const record = getRecord(productId);
        if (record?.status === 'flagged') {
          deleteRecord(productId);
          return;
        }

        patchRecord(productId, {
          status: 'flagged',
          flaggedAt: Date.now(),
          parsedAt: null,
          parsedManually: false,
          url: canonicalProductUrl(productId),
        });
      });
    }

    updateCardControls(card, productId);
  }

  function updateCardControls(card, productId) {
    const controls = card.querySelector(`:scope > [${UI_ATTR}="card-controls"]`);
    if (!controls) return;

    const record = getRecord(productId);
    const label = recordLabel(record);
    const statusButton = controls.querySelector('.ap-status');
    const flagButton = controls.querySelector('.ap-flag');

    statusButton.className = `ap-status ${label.cls}`;
    statusButton.textContent = `${label.symbol} ${label.text}`;
    statusButton.title = record?.status === 'parsed'
      ? 'Gia parsato. Clicca per azzerare lo stato.'
      : 'Clicca per segnare manualmente come parsato.';

    flagButton.classList.toggle('is-active', record?.status === 'flagged');
    card.classList.toggle('ap-card-done', record?.status === 'parsed' || record?.status === 'flagged');
  }

  function attachNavigationGuard(card, productId) {
    if (card.dataset.aliParserGuard === '1') return;
    card.dataset.aliParserGuard = '1';

    card.addEventListener('click', (event) => {
      if (event.target.closest(`[${UI_ATTR}]`)) return;

      const anchor = event.target.closest('a[href]');
      if (!anchor || extractProductId(anchor.href) !== productId) return;

      const record = getRecord(productId);
      if (!record || !['parsed', 'flagged'].includes(record.status)) return;

      const kind = record.status === 'parsed' ? 'GIA PARSATO' : 'FLAGGATO MANUALMENTE';
      const proceed = confirm(`${kind}\n\nProdotto ${productId}\n\nVuoi aprirlo comunque?`);
      if (!proceed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function scanSearchCards() {
    if (isProductPage()) return;

    const anchors = document.querySelectorAll('a[href*="/item/"]');
    const seen = new Set();

    for (const anchor of anchors) {
      const productId = extractProductId(anchor.href);
      if (!productId || seen.has(productId)) continue;

      const card = findCard(anchor);
      if (!card) continue;
      seen.add(productId);

      card.setAttribute(CARD_ATTR, productId);
      buildCardControls(card, productId);
      attachNavigationGuard(card, productId);
    }

    renderToolbar(seen);
  }

  function renderToolbar(visibleIds) {
    if (isProductPage()) {
      state.toolbar?.remove();
      state.toolbar = null;
      return;
    }

    if (!state.toolbar) {
      state.toolbar = document.createElement('div');
      state.toolbar.setAttribute(UI_ATTR, 'toolbar');
      state.toolbar.className = 'ap-toolbar';
      document.body.appendChild(state.toolbar);
    }

    const ids = visibleIds || new Set(
      [...document.querySelectorAll(`[${CARD_ATTR}]`)].map((el) => el.getAttribute(CARD_ATTR))
    );

    let parsed = 0;
    let flagged = 0;
    let viewed = 0;
    let fresh = 0;

    for (const id of ids) {
      const record = getRecord(id);
      if (record?.status === 'parsed') parsed += 1;
      else if (record?.status === 'flagged') flagged += 1;
      else if (record?.lastOpenedAt) viewed += 1;
      else fresh += 1;
    }

    state.toolbar.innerHTML = `
      <strong>Ali Parser</strong>
      <span>${ids.size} trovati</span>
      <span class="ap-tb-parsed">✓ ${parsed}</span>
      <span class="ap-tb-flagged">⚑ ${flagged}</span>
      <span>● ${viewed}</span>
      <span>○ ${fresh}</span>
    `;
  }

  function markCurrentProductOpened(productId) {
    const current = getRecord(productId) || {};
    patchRecord(productId, {
      status: current.status || null,
      lastOpenedAt: Date.now(),
      url: location.href,
      title: document.querySelector('h1')?.textContent?.trim() || current.title || '',
    });
  }

  function renderProductPanel() {
    const productId = extractProductId(location.href);
    if (!productId) {
      state.panel?.remove();
      state.panel = null;
      return;
    }

    if (!state.panel) {
      state.panel = document.createElement('div');
      state.panel.setAttribute(UI_ATTR, 'product-panel');
      state.panel.className = 'ap-product-panel';
      document.body.appendChild(state.panel);
    }

    const record = getRecord(productId);
    const label = recordLabel(record);
    const parsedDate = record?.parsedAt ? new Date(record.parsedAt).toLocaleString('it-IT') : '';

    state.panel.innerHTML = `
      <div class="ap-panel-title">Ali Parser</div>
      <div class="ap-panel-id">ID ${productId}</div>
      <div class="ap-panel-state ${label.cls}">${label.symbol} ${label.text}</div>
      ${parsedDate ? `<div class="ap-panel-date">${escapeHtml(parsedDate)}</div>` : ''}
      <div class="ap-panel-actions">
        <button type="button" data-action="parsed">✓ Segna parsato</button>
        <button type="button" data-action="flag">⚑ Flag</button>
        <button type="button" data-action="reset">↺</button>
      </div>
    `;

    state.panel.querySelector('[data-action="parsed"]').addEventListener('click', () => {
      patchRecord(productId, {
        status: 'parsed',
        parsedAt: Date.now(),
        parsedManually: true,
        flaggedAt: null,
        url: location.href,
        title: document.querySelector('h1')?.textContent?.trim() || '',
      });
    });

    state.panel.querySelector('[data-action="flag"]').addEventListener('click', () => {
      patchRecord(productId, {
        status: 'flagged',
        flaggedAt: Date.now(),
        parsedAt: null,
        parsedManually: false,
        url: location.href,
        title: document.querySelector('h1')?.textContent?.trim() || '',
      });
    });

    state.panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      if (confirm(`Azzerare lo stato del prodotto ${productId}?`)) deleteRecord(productId);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function refreshUi() {
    document.querySelectorAll(`[${CARD_ATTR}]`).forEach((card) => {
      updateCardControls(card, card.getAttribute(CARD_ATTR));
    });
    renderToolbar();
    renderProductPanel();
  }

  function handlePage() {
    if (isProductPage()) {
      const productId = extractProductId(location.href);
      if (productId) markCurrentProductOpened(productId);
      renderProductPanel();
      return;
    }

    scanSearchCards();
  }

  function exportRegistry() {
    const data = JSON.stringify(loadRegistry(), null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ali-parser-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function resetRegistry() {
    if (!confirm('Cancellare TUTTI gli stati salvati da Ali Parser?')) return;
    GM_deleteValue(STORE_KEY);
    refreshUi();
  }

  function installStyles() {
    const style = document.createElement('style');
    style.setAttribute(UI_ATTR, 'styles');
    style.textContent = `
      .ap-card-controls {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 9998;
        display: flex;
        gap: 5px;
        align-items: center;
        font-family: Arial, sans-serif;
      }
      .ap-card-controls button {
        border: 1px solid rgba(0,0,0,.16);
        box-shadow: 0 2px 8px rgba(0,0,0,.16);
        cursor: pointer;
        font-weight: 700;
      }
      .ap-status {
        min-height: 28px;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 11px;
        background: #fff;
        color: #333;
      }
      .ap-status.ap-parsed { background: #167d3f; color: #fff; }
      .ap-status.ap-flagged { background: #b76b00; color: #fff; }
      .ap-status.ap-viewed { background: #1f66b2; color: #fff; }
      .ap-status.ap-new { background: rgba(255,255,255,.96); color: #333; }
      .ap-flag {
        width: 29px;
        height: 29px;
        border-radius: 50%;
        background: rgba(255,255,255,.96);
        color: #555;
        font-size: 14px;
      }
      .ap-flag.is-active { background: #b76b00; color: #fff; }
      .ap-card-done { opacity: .62 !important; }
      .ap-card-done:hover { opacity: 1 !important; }
      .ap-toolbar {
        position: fixed;
        left: 14px;
        bottom: 14px;
        z-index: 99999;
        display: flex;
        gap: 9px;
        align-items: center;
        padding: 9px 12px;
        border-radius: 10px;
        background: rgba(22,22,22,.94);
        color: #fff;
        box-shadow: 0 5px 18px rgba(0,0,0,.28);
        font: 12px/1.2 Arial, sans-serif;
      }
      .ap-toolbar strong { font-size: 13px; }
      .ap-tb-parsed { color: #7ee2a2; }
      .ap-tb-flagged { color: #ffca78; }
      .ap-product-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 99999;
        width: 230px;
        box-sizing: border-box;
        padding: 12px;
        border-radius: 12px;
        background: rgba(22,22,22,.96);
        color: #fff;
        box-shadow: 0 6px 24px rgba(0,0,0,.35);
        font: 12px/1.3 Arial, sans-serif;
      }
      .ap-panel-title { font-size: 14px; font-weight: 800; margin-bottom: 2px; }
      .ap-panel-id { opacity: .7; font-size: 11px; margin-bottom: 8px; word-break: break-all; }
      .ap-panel-state { display: inline-block; border-radius: 999px; padding: 5px 9px; font-weight: 800; margin-bottom: 5px; }
      .ap-panel-state.ap-parsed { background: #167d3f; }
      .ap-panel-state.ap-flagged { background: #b76b00; }
      .ap-panel-state.ap-viewed { background: #1f66b2; }
      .ap-panel-state.ap-new { background: #555; }
      .ap-panel-date { opacity: .72; margin: 2px 0 8px; }
      .ap-panel-actions { display: flex; gap: 6px; margin-top: 8px; }
      .ap-panel-actions button {
        flex: 1;
        border: 0;
        border-radius: 7px;
        padding: 7px 6px;
        background: #fff;
        color: #222;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
      }
      .ap-panel-actions button:last-child { flex: 0 0 32px; }
    `;
    document.head.appendChild(style);
  }

  function startObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => {
      clearTimeout(state.scanTimer);
      state.scanTimer = setTimeout(() => {
        if (!isProductPage()) scanSearchCards();
      }, 250);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function watchUrlChanges() {
    setInterval(() => {
      if (state.currentUrl === location.href) return;
      state.currentUrl = location.href;
      setTimeout(handlePage, 300);
    }, 700);
  }

  GM_addValueChangeListener(STORE_KEY, () => refreshUi());
  GM_registerMenuCommand('Ali Parser: esporta registro JSON', exportRegistry);
  GM_registerMenuCommand('Ali Parser: azzera tutti gli stati', resetRegistry);

  installStyles();
  startObserver();
  watchUrlChanges();
  handlePage();
})();
