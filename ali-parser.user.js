// ==UserScript==
// @name         Ali Parser - Parsing Tracker
// @namespace    https://github.com/menteora/ali-parser
// @version      0.2.0
// @description  Tiene traccia dei prodotti AliExpress gia aperti/parsati e permette di flaggarli manualmente ovunque compaiano.
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

    const raw = String(input);
    const variants = [raw];

    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) variants.push(decoded);
    } catch (_) {
      // URL non codificato correttamente: prosegui con il valore originale.
    }

    for (const value of variants) {
      try {
        const url = new URL(value, location.href);
        const pathMatch = url.pathname.match(/\/item\/(\d{8,})(?:\.html)?/i);
        if (pathMatch) return pathMatch[1];

        const paramNames = ['productId', 'product_id', 'itemId', 'item_id'];
        for (const name of paramNames) {
          const candidate = url.searchParams.get(name);
          if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
        }
      } catch (_) {
        // Fallback regex sotto.
      }

      const fallback = value.match(/(?:\/item\/|productId=|product_id=|itemId=|item_id=)(\d{8,})/i);
      if (fallback) return fallback[1];
    }

    return null;
  }

  function getElementProductId(element) {
    if (!element) return null;

    const attrs = [
      element.getAttribute?.('data-product-id'),
      element.getAttribute?.('data-item-id'),
      element.dataset?.productId,
      element.dataset?.itemId,
      element.href,
      element.getAttribute?.('href'),
    ];

    for (const value of attrs) {
      const productId = extractProductId(value);
      if (productId) return productId;
      if (value && /^\d{8,}$/.test(String(value))) return String(value);
    }

    return null;
  }

  function canonicalProductUrl(productId) {
    return `${location.origin}/item/${productId}.html`;
  }

  function currentProductId() {
    return extractProductId(location.href);
  }

  function isProductPage() {
    return Boolean(currentProductId());
  }

  function recordLabel(record) {
    if (!record) return { text: 'NUOVO', symbol: '○', cls: 'ap-new' };
    if (record.status === 'parsed') return { text: 'PARSATO', symbol: '✓', cls: 'ap-parsed' };
    if (record.status === 'flagged') return { text: 'FLAG', symbol: '⚑', cls: 'ap-flagged' };
    if (record.lastOpenedAt) return { text: 'VISTO', symbol: '●', cls: 'ap-viewed' };
    return { text: 'NUOVO', symbol: '○', cls: 'ap-new' };
  }

  function countDistinctProducts(node, stopAfter = 3) {
    const ids = new Set();
    const links = node.querySelectorAll?.('a[href]') || [];

    for (const link of links) {
      const id = getElementProductId(link);
      if (!id) continue;
      ids.add(id);
      if (ids.size >= stopAfter) break;
    }

    return ids.size;
  }

  function looksLikeProductCard(node, productId) {
    if (!(node instanceof HTMLElement)) return false;
    if (node === document.body || node === document.documentElement) return false;

    const rect = node.getBoundingClientRect();
    if (rect.width < 90 || rect.height < 90) return false;
    if (rect.width > 720 || rect.height > 950) return false;

    const image = node.querySelector('img');
    if (!image) return false;

    const idsInside = countDistinctProducts(node, 3);
    if (idsInside > 2) return false;

    const ownId = getElementProductId(node);
    if (ownId && ownId !== productId) return false;

    return true;
  }

  function findCard(anchor, productId) {
    const preferredSelectors = [
      '.search-card-item',
      '[class*="search-card"]',
      '[class*="product-card"]',
      '[class*="productCard"]',
      '[class*="card-out-wrapper"]',
      '[class*="product-item"]',
      '[class*="productItem"]',
      '[data-product-id]',
      '[data-item-id]',
    ];

    for (const selector of preferredSelectors) {
      const found = anchor.closest(selector);
      if (found && looksLikeProductCard(found, productId)) return found;
    }

    let node = anchor;
    let best = null;

    for (let depth = 0; depth < 9 && node && node !== document.body; depth += 1, node = node.parentElement) {
      if (!looksLikeProductCard(node, productId)) continue;
      best = node;
      break;
    }

    if (best) return best;

    // Ultimo fallback: il contenitore piu vicino con un'immagine, anche se AliExpress
    // ha cambiato completamente le classi della card.
    node = anchor;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      if (!node.querySelector('img')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 80 && rect.width <= 800 && rect.height <= 1000) return node;
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
        event.stopImmediatePropagation();

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
          flaggedAt: null,
          url: canonicalProductUrl(productId),
        });
      });

      controls.querySelector('.ap-flag').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

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
    statusButton.textContent = label.symbol;
    statusButton.setAttribute('aria-label', label.text);
    statusButton.title = record?.status === 'parsed'
      ? 'Gia parsato. Clicca per azzerare lo stato.'
      : record?.lastOpenedAt
        ? 'Gia visto. Clicca per segnare come parsato.'
        : 'Non ancora parsato. Clicca per segnare manualmente come parsato.';

    flagButton.classList.toggle('is-active', record?.status === 'flagged');
    flagButton.title = record?.status === 'flagged'
      ? 'Flag manuale attivo. Clicca per rimuoverlo.'
      : 'Flag manuale: considera questo articolo gia gestito.';

    card.classList.toggle('ap-card-done', record?.status === 'parsed' || record?.status === 'flagged');
  }

  function collectProductAnchors() {
    const anchors = document.querySelectorAll('a[href]');
    const result = [];

    for (const anchor of anchors) {
      if (anchor.closest(`[${UI_ATTR}]`)) continue;
      const productId = getElementProductId(anchor);
      if (!productId) continue;
      result.push({ anchor, productId });
    }

    return result;
  }

  function scanProductCards() {
    if (isProductPage()) return;

    const found = collectProductAnchors();
    const visibleIds = new Set();
    const mountedIds = new Set();

    for (const { anchor, productId } of found) {
      visibleIds.add(productId);
      if (mountedIds.has(productId)) continue;

      const card = findCard(anchor, productId);
      if (!card) continue;

      const existingId = card.getAttribute(CARD_ATTR);
      if (existingId && existingId !== productId) continue;

      mountedIds.add(productId);
      card.setAttribute(CARD_ATTR, productId);
      buildCardControls(card, productId);
    }

    renderToolbar(visibleIds);
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
      [...document.querySelectorAll(`[${CARD_ATTR}]`)]
        .map((el) => el.getAttribute(CARD_ATTR))
        .filter(Boolean)
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
      <span>${ids.size} prodotti</span>
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
    const productId = currentProductId();
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
        <button type="button" data-action="parsed">✓ Parsato</button>
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
      const recordNow = getRecord(productId);
      if (recordNow?.status === 'flagged') {
        deleteRecord(productId);
        return;
      }

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
      const productId = currentProductId();
      if (productId) markCurrentProductOpened(productId);
      renderProductPanel();
      return;
    }

    state.panel?.remove();
    state.panel = null;
    scanProductCards();
  }

  function installGlobalNavigationGuard() {
    document.addEventListener('click', (event) => {
      if (event.target.closest(`[${UI_ATTR}]`)) return;

      const anchor = event.target.closest('a[href]');
      if (!anchor) return;

      const productId = getElementProductId(anchor);
      if (!productId) return;

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
    if (document.querySelector(`[${UI_ATTR}="styles"]`)) return;

    const style = document.createElement('style');
    style.setAttribute(UI_ATTR, 'styles');
    style.textContent = `
      .ap-card-controls {
        position: absolute !important;
        top: 7px !important;
        right: 7px !important;
        z-index: 2147483000 !important;
        display: flex !important;
        gap: 5px !important;
        align-items: center !important;
        pointer-events: auto !important;
        font-family: Arial, sans-serif !important;
      }
      .ap-card-controls button {
        box-sizing: border-box !important;
        width: 30px !important;
        min-width: 30px !important;
        height: 30px !important;
        padding: 0 !important;
        border: 1px solid rgba(0,0,0,.18) !important;
        border-radius: 50% !important;
        box-shadow: 0 2px 8px rgba(0,0,0,.24) !important;
        cursor: pointer !important;
        font: 800 15px/28px Arial, sans-serif !important;
        text-align: center !important;
      }
      .ap-status.ap-parsed { background: #167d3f !important; color: #fff !important; }
      .ap-status.ap-flagged { background: #b76b00 !important; color: #fff !important; }
      .ap-status.ap-viewed { background: #1f66b2 !important; color: #fff !important; }
      .ap-status.ap-new { background: rgba(255,255,255,.97) !important; color: #333 !important; }
      .ap-flag { background: rgba(255,255,255,.97) !important; color: #555 !important; }
      .ap-flag.is-active { background: #b76b00 !important; color: #fff !important; }
      .ap-card-done { opacity: .58 !important; }
      .ap-card-done:hover { opacity: 1 !important; }
      .ap-toolbar {
        position: fixed !important;
        left: 14px !important;
        bottom: 14px !important;
        z-index: 2147483646 !important;
        display: flex !important;
        gap: 9px !important;
        align-items: center !important;
        padding: 9px 12px !important;
        border-radius: 10px !important;
        background: rgba(22,22,22,.94) !important;
        color: #fff !important;
        box-shadow: 0 5px 18px rgba(0,0,0,.28) !important;
        font: 12px/1.2 Arial, sans-serif !important;
      }
      .ap-toolbar strong { font-size: 13px !important; }
      .ap-tb-parsed { color: #7ee2a2 !important; }
      .ap-tb-flagged { color: #ffca78 !important; }
      .ap-product-panel {
        position: fixed !important;
        right: 16px !important;
        bottom: 16px !important;
        z-index: 2147483646 !important;
        width: 230px !important;
        box-sizing: border-box !important;
        padding: 12px !important;
        border-radius: 12px !important;
        background: rgba(22,22,22,.96) !important;
        color: #fff !important;
        box-shadow: 0 6px 24px rgba(0,0,0,.35) !important;
        font: 12px/1.3 Arial, sans-serif !important;
      }
      .ap-panel-title { font-size: 14px !important; font-weight: 800 !important; margin-bottom: 2px !important; }
      .ap-panel-id { opacity: .7 !important; font-size: 11px !important; margin-bottom: 8px !important; word-break: break-all !important; }
      .ap-panel-state { display: inline-block !important; border-radius: 999px !important; padding: 5px 9px !important; font-weight: 800 !important; margin-bottom: 5px !important; }
      .ap-panel-state.ap-parsed { background: #167d3f !important; }
      .ap-panel-state.ap-flagged { background: #b76b00 !important; }
      .ap-panel-state.ap-viewed { background: #1f66b2 !important; }
      .ap-panel-state.ap-new { background: #555 !important; }
      .ap-panel-date { opacity: .72 !important; margin: 2px 0 8px !important; }
      .ap-panel-actions { display: flex !important; gap: 6px !important; margin-top: 8px !important; }
      .ap-panel-actions button {
        flex: 1 !important;
        border: 0 !important;
        border-radius: 7px !important;
        padding: 7px 6px !important;
        background: #fff !important;
        color: #222 !important;
        cursor: pointer !important;
        font-size: 11px !important;
        font-weight: 700 !important;
      }
      .ap-panel-actions button:last-child { flex: 0 0 32px !important; }
    `;
    document.head.appendChild(style);
  }

  function scheduleScan(delay = 350) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      if (!isProductPage()) scanProductCards();
    }, delay);
  }

  function startObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => scheduleScan());
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
  installGlobalNavigationGuard();
  startObserver();
  watchUrlChanges();
  handlePage();
  setTimeout(handlePage, 1200);
  setTimeout(handlePage, 3000);
})();
