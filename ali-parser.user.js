// ==UserScript==
// @name         Ali Parser - Parsing Tracker
// @namespace    https://github.com/menteora/ali-parser
// @version      0.7.1
// @description  Salva stato e note dei prodotti AliExpress, mostra le note nelle preview e offre un registro visuale consultabile e copiabile.
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
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'ali-parser:products:v1';
  const UI_ATTR = 'data-ali-parser-ui';
  const CARD_ATTR = 'data-ali-parser-key';

  const state = {
    currentUrl: location.href,
    observer: null,
    scanTimer: null,
    toolbar: null,
    panel: null,
    registryModal: null,
    registryQuery: '',
    registryFilter: 'all',
  };

  function loadRegistry() {
    const value = GM_getValue(STORE_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }

  function saveRegistry(registry) {
    GM_setValue(STORE_KEY, registry);
  }

  function getRecord(key) {
    return loadRegistry()[key] || null;
  }

  function patchRecord(key, patch) {
    const registry = loadRegistry();
    const previous = registry[key] || { key };
    registry[key] = {
      ...previous,
      ...patch,
      key,
      updatedAt: Date.now(),
    };
    saveRegistry(registry);
    refreshUi();
    return registry[key];
  }

  function deleteRecord(key) {
    const registry = loadRegistry();
    delete registry[key];
    saveRegistry(registry);
    refreshUi();
  }

  function clearProductState(key, { clearOpened = false } = {}) {
    const record = getRecord(key);
    if (!record) return;

    patchRecord(key, {
      status: null,
      flaggedAt: null,
      parsedAt: null,
      ...(clearOpened ? { lastOpenedAt: null } : {}),
    });
  }

  function safeDecode(value) {
    let current = String(value || '');
    for (let i = 0; i < 3; i += 1) {
      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) break;
        current = decoded;
      } catch (_) {
        break;
      }
    }
    return current;
  }

  function extractProductId(input) {
    if (!input) return null;

    const values = [String(input), safeDecode(input)];
    const patterns = [
      /\/item\/(\d{8,})(?:\.html)?/i,
      /(?:productId|product_id|itemId|item_id)[=/:](\d{8,})/i,
      /(?:productId|product_id|itemId|item_id)%3D(\d{8,})/i,
      /\b(100\d{10,})\b/,
    ];

    for (const value of values) {
      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return match[1];
      }

      try {
        const url = new URL(value, location.href);
        for (const name of ['productId', 'product_id', 'itemId', 'item_id']) {
          const candidate = url.searchParams.get(name);
          if (candidate && /^\d{8,}$/.test(candidate)) return candidate;
        }

        for (const name of ['url', 'redirect', 'redirectUrl', 'target', 'targetUrl', 'to']) {
          const nested = url.searchParams.get(name);
          if (!nested) continue;
          const nestedId = extractProductId(nested);
          if (nestedId) return nestedId;
        }
      } catch (_) {
        // Continua con gli altri formati.
      }
    }

    return null;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeHref(href) {
    try {
      const url = new URL(href, location.href);
      for (const name of [...url.searchParams.keys()]) {
        if (/^(spm|gatewayAdapt|sourceType|channel|aff_|algo_|scm|pvid|utparam|businessType)/i.test(name)) {
          url.searchParams.delete(name);
        }
      }
      url.hash = '';
      return url.toString();
    } catch (_) {
      return String(href || '');
    }
  }

  function productIdentityFromAnchor(anchor) {
    if (!anchor) return null;

    const sources = [
      anchor.href,
      anchor.getAttribute('href'),
      anchor.dataset?.productId,
      anchor.dataset?.itemId,
      anchor.getAttribute('data-product-id'),
      anchor.getAttribute('data-item-id'),
      anchor.outerHTML?.slice(0, 5000),
    ].filter(Boolean);

    let productId = null;
    for (const source of sources) {
      productId = extractProductId(source);
      if (productId) break;
    }

    if (productId) {
      return {
        key: productId,
        productId,
        href: anchor.href || '',
        fallback: false,
      };
    }

    const href = normalizeHref(anchor.href || anchor.getAttribute('href') || '');
    if (!href || !looksLikeProductHref(href)) return null;

    return {
      key: `url:${hashString(href)}`,
      productId: null,
      href,
      fallback: true,
    };
  }

  function looksLikeProductHref(href) {
    const value = safeDecode(href).toLowerCase();
    return value.includes('/item/') ||
      value.includes('productid') ||
      value.includes('itemid') ||
      value.includes('/pdp/') ||
      value.includes('product-detail') ||
      /\b100\d{10,}\b/.test(value);
  }

  function currentProductId() {
    return extractProductId(location.href);
  }

  function isProductPage() {
    return Boolean(currentProductId()) || /\/item\//i.test(location.pathname);
  }

  function visibleImageIn(node) {
    const images = node.querySelectorAll?.('img') || [];
    for (const image of images) {
      const rect = image.getBoundingClientRect();
      if (rect.width >= 70 && rect.height >= 70) return image;
    }
    return null;
  }

  function countProductLinks(node, stopAfter = 3) {
    const keys = new Set();
    const links = node.querySelectorAll?.('a[href]') || [];

    for (const link of links) {
      const identity = productIdentityFromAnchor(link);
      if (!identity) continue;
      keys.add(identity.key);
      if (keys.size >= stopAfter) break;
    }

    return keys.size;
  }

  function findCard(anchor) {
    const preferred = [
      '.search-card-item',
      '[class*="search-card"]',
      '[class*="product-card"]',
      '[class*="productCard"]',
      '[class*="card-out-wrapper"]',
      '[class*="product-item"]',
      '[class*="productItem"]',
      '[class*="recommend"]',
      '[class*="Recommend"]',
      '[data-product-id]',
      '[data-item-id]',
    ];

    for (const selector of preferred) {
      const node = anchor.closest(selector);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 90 && rect.height >= 90 && visibleImageIn(node)) return node;
    }

    let node = anchor;
    let best = null;

    for (let depth = 0; depth < 9 && node && node !== document.body; depth += 1, node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 90 || rect.height < 90 || rect.width > 700 || rect.height > 900) continue;
      if (!visibleImageIn(node)) continue;

      const productLinks = countProductLinks(node, 3);
      if (productLinks > 2) continue;

      best = node;
      if (productLinks === 1 && rect.width >= 140 && rect.height >= 140) break;
    }

    if (best) return best;

    const image = anchor.querySelector('img');
    if (image && anchor instanceof HTMLElement) return anchor;

    return null;
  }

  function statusInfo(record) {
    if (!record) return { label: 'Nuovo', cls: 'ap-new' };
    if (record.status === 'parsed') return { label: 'Parsato', cls: 'ap-parsed' };
    if (record.status === 'flagged') return { label: 'Flag', cls: 'ap-flagged' };
    if (record.lastOpenedAt) return { label: 'Visto', cls: 'ap-viewed' };
    return { label: 'Nuovo', cls: 'ap-new' };
  }

  function toggleManualFlag(identity) {
    const record = getRecord(identity.key);

    if (record?.status === 'parsed') {
      const reset = confirm('Questo articolo risulta gia parsato. Vuoi togliere il check e azzerare lo stato? La nota verra mantenuta.');
      if (reset) clearProductState(identity.key, { clearOpened: true });
      return;
    }

    if (record?.status === 'flagged') {
      clearProductState(identity.key);
      return;
    }

    patchRecord(identity.key, {
      productId: identity.productId,
      status: 'flagged',
      flaggedAt: Date.now(),
      parsedAt: null,
      href: identity.href,
      identityFallback: identity.fallback,
    });
  }

  function mountCheckbox(card, identity) {
    let control = card.querySelector(`:scope > [${UI_ATTR}="card-check"]`);

    if (!control) {
      control = document.createElement('button');
      control.type = 'button';
      control.setAttribute(UI_ATTR, 'card-check');
      control.className = 'ap-card-check';
      control.innerHTML = '<span class="ap-checkmark"></span><span class="ap-card-label"></span>';

      const computed = getComputedStyle(card);
      if (computed.position === 'static') card.style.setProperty('position', 'relative', 'important');

      control.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const key = control.dataset.key;
        const liveIdentity = {
          key,
          productId: control.dataset.productId || null,
          href: control.dataset.href || '',
          fallback: control.dataset.fallback === '1',
        };
        toggleManualFlag(liveIdentity);
      }, true);

      card.appendChild(control);
    }

    control.dataset.key = identity.key;
    control.dataset.productId = identity.productId || '';
    control.dataset.href = identity.href || '';
    control.dataset.fallback = identity.fallback ? '1' : '0';
    updateCheckbox(control, identity.key);
  }

  function updateCheckbox(control, key) {
    const record = getRecord(key);
    const info = statusInfo(record);
    const checkmark = control.querySelector('.ap-checkmark');
    const label = control.querySelector('.ap-card-label');

    control.className = `ap-card-check ${info.cls}`;
    control.title = record?.status === 'parsed'
      ? 'Gia parsato. Clicca per azzerare.'
      : record?.status === 'flagged'
        ? 'Flag manuale attivo. Clicca per rimuoverlo.'
        : record?.lastOpenedAt
          ? 'Gia visto. Clicca per mettere il check manuale.'
          : 'Clicca per segnare questo articolo come gia gestito.';

    control.setAttribute('aria-label', info.label);

    if (record?.status === 'parsed') {
      checkmark.textContent = '✓';
      label.textContent = 'PARSATO';
    } else if (record?.status === 'flagged') {
      checkmark.textContent = '✓';
      label.textContent = 'FLAG';
    } else if (record?.lastOpenedAt) {
      checkmark.textContent = '•';
      label.textContent = 'VISTO';
    } else {
      checkmark.textContent = '';
      label.textContent = '';
    }
  }

  function mountCardNote(card, identity) {
    let note = card.querySelector(`:scope > [${UI_ATTR}="card-note"]`);

    if (!note) {
      note = document.createElement('div');
      note.setAttribute(UI_ATTR, 'card-note');
      note.className = 'ap-card-note ap-card-note-empty';
      card.appendChild(note);
    }

    note.dataset.key = identity.key;
    updateCardNote(note, identity.key);
  }

  function updateCardNote(note, key) {
    const record = getRecord(key);
    const text = String(record?.note || '').trim();

    note.classList.toggle('ap-card-note-empty', !text);
    note.textContent = text ? `NOTA · ${text}` : '';
    note.title = text;
    note.setAttribute('aria-label', text ? `Nota prodotto: ${text}` : '');
  }

  function resetRecycledCard(card) {
    card.querySelectorAll(`:scope > [${UI_ATTR}="card-check"], :scope > [${UI_ATTR}="card-note"]`).forEach((node) => node.remove());
    card.removeAttribute(CARD_ATTR);
  }

  function collectCards() {
    const visibleKeys = new Set();
    const mountedCards = new WeakSet();
    const anchors = document.querySelectorAll('a[href]');
    const current = isProductPage() ? currentIdentity() : null;
    const currentKey = current?.key || null;

    for (const anchor of anchors) {
      if (anchor.closest(`[${UI_ATTR}]`)) continue;

      const identity = productIdentityFromAnchor(anchor);
      if (!identity) continue;

      // Nella pagina prodotto il prodotto principale usa il pannello laterale.
      // Tutti gli altri link prodotto (correlati, suggeriti, sponsorizzati) ricevono stato e nota.
      if (currentKey && identity.key === currentKey) continue;

      const card = findCard(anchor);
      if (!card) continue;
      if (mountedCards.has(card)) continue;

      const existingKey = card.getAttribute(CARD_ATTR);
      if (existingKey && existingKey !== identity.key) {
        // AliExpress riutilizza spesso la stessa card per un prodotto diverso nei caroselli SPA.
        resetRecycledCard(card);
      }

      mountedCards.add(card);
      visibleKeys.add(identity.key);
      card.setAttribute(CARD_ATTR, identity.key);
      mountCheckbox(card, identity);
      mountCardNote(card, identity);
    }

    return visibleKeys;
  }

  function renderToolbar(visibleKeys) {
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

    const keys = visibleKeys || new Set(
      [...document.querySelectorAll(`[${CARD_ATTR}]`)]
        .map((el) => el.getAttribute(CARD_ATTR))
        .filter(Boolean)
    );

    let parsed = 0;
    let flagged = 0;
    let viewed = 0;
    let fresh = 0;
    let noted = 0;

    for (const key of keys) {
      const record = getRecord(key);
      if (record?.status === 'parsed') parsed += 1;
      else if (record?.status === 'flagged') flagged += 1;
      else if (record?.lastOpenedAt) viewed += 1;
      else fresh += 1;

      if (String(record?.note || '').trim()) noted += 1;
    }

    state.toolbar.innerHTML = `
      <strong>Ali Parser</strong>
      <span>${keys.size} schede</span>
      <span class="ap-tb-parsed">✓ ${parsed}</span>
      <span class="ap-tb-flagged">Flag ${flagged}</span>
      <span>Visti ${viewed}</span>
      <span>Nuovi ${fresh}</span>
      <span class="ap-tb-noted">Note ${noted}</span>
      <button type="button" class="ap-toolbar-registry" data-action="open-registry">Registro</button>
    `;

    state.toolbar.querySelector('[data-action="open-registry"]')?.addEventListener('click', openRegistryModal);
  }

  function currentIdentity() {
    const productId = currentProductId();
    if (productId) {
      return {
        key: productId,
        productId,
        href: location.href,
        fallback: false,
      };
    }

    if (/\/item\//i.test(location.pathname)) {
      const href = normalizeHref(location.href);
      return {
        key: `url:${hashString(href)}`,
        productId: null,
        href,
        fallback: true,
      };
    }

    return null;
  }

  function markCurrentOpened(identity) {
    if (!identity) return;
    const current = getRecord(identity.key) || {};
    patchRecord(identity.key, {
      productId: identity.productId,
      status: current.status || null,
      lastOpenedAt: Date.now(),
      href: location.href,
      title: document.querySelector('h1')?.textContent?.trim() || current.title || '',
      identityFallback: identity.fallback,
    });
  }

  function renderProductPanel() {
    const identity = currentIdentity();
    if (!identity) {
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

    const record = getRecord(identity.key);
    const info = statusInfo(record);

    state.panel.innerHTML = `
      <div class="ap-panel-head">
        <div class="ap-panel-title">Ali Parser</div>
        <button type="button" class="ap-panel-registry" data-action="open-registry">Registro</button>
      </div>
      <div class="ap-panel-status ${info.cls}">${escapeHtml(info.label)}</div>
      <label class="ap-panel-check-row">
        <input type="checkbox" data-action="flag" ${record?.status === 'flagged' || record?.status === 'parsed' ? 'checked' : ''}>
        <span>Gia gestito</span>
      </label>
      <button type="button" class="ap-panel-parsed" data-action="parsed">✓ Segna come parsato</button>
      <button type="button" class="ap-panel-reset" data-action="reset">Azzera stato</button>
      <div class="ap-panel-note-separator"></div>
      <label class="ap-panel-note-label" for="ap-product-note">Nota prodotto</label>
      <textarea id="ap-product-note" class="ap-panel-note" data-action="note" placeholder="Es. buon margine, packaging debole, da confrontare...">${escapeHtml(record?.note || '')}</textarea>
      <div class="ap-panel-note-help">Visibile anche nelle preview di questo prodotto.</div>
      <button type="button" class="ap-panel-note-save" data-action="save-note">Salva nota</button>
    `;

    state.panel.querySelector('[data-action="open-registry"]')?.addEventListener('click', openRegistryModal);

    state.panel.querySelector('[data-action="flag"]').addEventListener('change', () => {
      toggleManualFlag(identity);
    });

    state.panel.querySelector('[data-action="parsed"]').addEventListener('click', () => {
      patchRecord(identity.key, {
        productId: identity.productId,
        status: 'parsed',
        parsedAt: Date.now(),
        flaggedAt: null,
        href: location.href,
        title: document.querySelector('h1')?.textContent?.trim() || '',
        identityFallback: identity.fallback,
      });
    });

    state.panel.querySelector('[data-action="reset"]').addEventListener('click', () => {
      clearProductState(identity.key, { clearOpened: true });
    });

    const noteInput = state.panel.querySelector('[data-action="note"]');
    const saveNote = () => {
      patchRecord(identity.key, {
        productId: identity.productId,
        href: location.href,
        title: document.querySelector('h1')?.textContent?.trim() || record?.title || '',
        identityFallback: identity.fallback,
        note: noteInput.value.trim(),
        noteUpdatedAt: Date.now(),
      });
    };

    state.panel.querySelector('[data-action="save-note"]').addEventListener('click', saveNote);
    noteInput.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveNote();
      }
    });
  }

  function safeProductHref(record) {
    const candidates = [record?.href];
    if (record?.productId) {
      candidates.push(`https://www.aliexpress.com/item/${record.productId}.html`);
    }

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate, location.href);
        if (!/^https?:$/.test(url.protocol)) continue;
        if (!/(^|\.)aliexpress\.com$/i.test(url.hostname)) continue;
        return url.toString();
      } catch (_) {
        // Prova il candidato successivo.
      }
    }

    return '';
  }

  function registryRecords() {
    return Object.values(loadRegistry())
      .filter((record) => record && typeof record === 'object')
      .sort((a, b) => (b.updatedAt || b.lastOpenedAt || 0) - (a.updatedAt || a.lastOpenedAt || 0));
  }

  function matchesRegistryFilter(record, filter) {
    if (filter === 'noted') return Boolean(String(record.note || '').trim());
    if (filter === 'parsed') return record.status === 'parsed';
    if (filter === 'flagged') return record.status === 'flagged';
    if (filter === 'viewed') return Boolean(record.lastOpenedAt) && !record.status;
    return true;
  }

  function filteredRegistryRecords() {
    const allRecords = registryRecords();
    const query = state.registryQuery.trim().toLowerCase();
    const filtered = allRecords.filter((record) => {
      if (!matchesRegistryFilter(record, state.registryFilter)) return false;
      if (!query) return true;

      const haystack = [
        record.title,
        record.note,
        record.href,
        record.productId,
        record.key,
        statusInfo(record).label,
      ].filter(Boolean).join(' ').toLowerCase();

      return haystack.includes(query);
    });

    return { allRecords, filtered };
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    try {
      return new Intl.DateTimeFormat('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(timestamp));
    } catch (_) {
      return '';
    }
  }

  function registryRowHtml(record) {
    const info = statusInfo(record);
    const href = safeProductHref(record);
    const title = String(record.title || '').trim() || (record.productId ? `Prodotto ${record.productId}` : record.key || 'Prodotto');
    const note = String(record.note || '').trim();
    const updated = record.noteUpdatedAt || record.updatedAt || record.lastOpenedAt;

    return `
      <article class="ap-registry-row">
        <div class="ap-registry-row-main">
          <div class="ap-registry-row-top">
            <span class="ap-registry-status ${info.cls}">${escapeHtml(info.label)}</span>
            <strong class="ap-registry-title">${escapeHtml(title)}</strong>
          </div>
          ${href ? `<a class="ap-registry-url" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>` : '<span class="ap-registry-url ap-registry-url-missing">Link non disponibile</span>'}
          <div class="ap-registry-note ${note ? '' : 'ap-registry-note-empty'}">${note ? escapeHtml(note) : 'Nessuna nota'}</div>
          <div class="ap-registry-meta">${updated ? `Aggiornato ${escapeHtml(formatDate(updated))}` : ''}</div>
        </div>
        ${href ? `<a class="ap-registry-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Apri</a>` : ''}
      </article>
    `;
  }

  function registryCopyText(records) {
    return records.map((record, index) => {
      const info = statusInfo(record);
      const href = safeProductHref(record);
      const title = String(record.title || '').trim() || (record.productId ? `Prodotto ${record.productId}` : record.key || 'Prodotto');
      const note = String(record.note || '').trim();

      return [
        `${index + 1}. ${title}`,
        `Stato: ${info.label}`,
        href ? `Link: ${href}` : '',
        note ? `Nota: ${note}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  }

  function copyRegistryView() {
    if (!state.registryModal) return;

    const { filtered } = filteredRegistryRecords();
    const button = state.registryModal.querySelector('[data-action="registry-copy"]');
    if (!filtered.length) {
      if (button) {
        const previous = button.textContent;
        button.textContent = 'Niente da copiare';
        setTimeout(() => {
          if (button.isConnected) button.textContent = previous;
        }, 1400);
      }
      return;
    }

    const text = registryCopyText(filtered);
    GM_setClipboard(text, 'text');

    if (button) {
      const previous = button.textContent;
      button.textContent = `Copiati ${filtered.length}`;
      setTimeout(() => {
        if (button.isConnected) button.textContent = previous;
      }, 1400);
    }
  }

  function renderRegistryList() {
    if (!state.registryModal) return;

    const { allRecords, filtered } = filteredRegistryRecords();
    const count = state.registryModal.querySelector('[data-role="registry-count"]');
    const total = state.registryModal.querySelector('[data-role="registry-total"]');
    const list = state.registryModal.querySelector('[data-role="registry-list"]');

    if (total) total.textContent = `${allRecords.length} salvati`;
    if (count) count.textContent = filtered.length === allRecords.length
      ? `${allRecords.length} prodotti nel registro`
      : `${filtered.length} visualizzati su ${allRecords.length}`;
    if (!list) return;

    list.innerHTML = filtered.length
      ? filtered.map(registryRowHtml).join('')
      : '<div class="ap-registry-empty">Nessun prodotto corrisponde alla ricerca.</div>';
  }

  function openRegistryModal() {
    if (state.registryModal) {
      state.registryModal.querySelector('[data-action="registry-search"]')?.focus();
      renderRegistryList();
      return;
    }

    const modal = document.createElement('div');
    modal.setAttribute(UI_ATTR, 'registry-modal');
    modal.className = 'ap-registry-overlay';
    modal.innerHTML = `
      <section class="ap-registry-modal" role="dialog" aria-modal="true" aria-label="Registro Ali Parser">
        <header class="ap-registry-head">
          <div>
            <div class="ap-registry-title-line">
              <div class="ap-registry-heading">Registro Ali Parser</div>
              <span class="ap-registry-total" data-role="registry-total">0 salvati</span>
            </div>
            <div class="ap-registry-subtitle">Link e note salvati, senza esportazione.</div>
          </div>
          <button type="button" class="ap-registry-close" data-action="registry-close" aria-label="Chiudi">×</button>
        </header>
        <div class="ap-registry-controls">
          <input type="search" class="ap-registry-search" data-action="registry-search" placeholder="Cerca titolo, link, ID o nota..." value="${escapeHtml(state.registryQuery)}">
          <select class="ap-registry-filter" data-action="registry-filter">
            <option value="all">Tutti</option>
            <option value="noted">Con nota</option>
            <option value="parsed">Parsati</option>
            <option value="flagged">Flag</option>
            <option value="viewed">Visti</option>
          </select>
          <button type="button" class="ap-registry-copy" data-action="registry-copy">Copia lista</button>
        </div>
        <div class="ap-registry-count" data-role="registry-count"></div>
        <div class="ap-registry-list" data-role="registry-list"></div>
      </section>
    `;

    document.body.appendChild(modal);
    state.registryModal = modal;

    const search = modal.querySelector('[data-action="registry-search"]');
    const filter = modal.querySelector('[data-action="registry-filter"]');
    filter.value = state.registryFilter;

    search.addEventListener('input', () => {
      state.registryQuery = search.value;
      renderRegistryList();
    });

    filter.addEventListener('change', () => {
      state.registryFilter = filter.value;
      renderRegistryList();
    });

    modal.querySelector('[data-action="registry-copy"]').addEventListener('click', copyRegistryView);
    modal.querySelector('[data-action="registry-close"]').addEventListener('click', closeRegistryModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeRegistryModal();
    });

    renderRegistryList();
    search.focus();
  }

  function closeRegistryModal() {
    state.registryModal?.remove();
    state.registryModal = null;
  }

  function installNavigationGuard() {
    document.addEventListener('click', (event) => {
      if (event.target.closest(`[${UI_ATTR}]`)) return;
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;

      const identity = productIdentityFromAnchor(anchor);
      if (!identity) return;

      const record = getRecord(identity.key);
      if (!record || !['parsed', 'flagged'].includes(record.status)) return;

      const label = record.status === 'parsed' ? 'GIA PARSATO' : 'GIA FLAGGATO';
      const proceed = confirm(`${label}\n\nVuoi aprire comunque questo articolo?`);
      if (!proceed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function installKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.registryModal) {
        closeRegistryModal();
      }
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function refreshUi() {
    document.querySelectorAll(`[${UI_ATTR}="card-check"]`).forEach((control) => {
      if (control.dataset.key) updateCheckbox(control, control.dataset.key);
    });
    document.querySelectorAll(`[${UI_ATTR}="card-note"]`).forEach((note) => {
      if (note.dataset.key) updateCardNote(note, note.dataset.key);
    });
    renderToolbar();
    renderProductPanel();
    renderRegistryList();
  }

  function handlePage() {
    if (isProductPage()) {
      state.toolbar?.remove();
      state.toolbar = null;
      const identity = currentIdentity();
      markCurrentOpened(identity);
      renderProductPanel();
      collectCards();
      return;
    }

    state.panel?.remove();
    state.panel = null;
    const visibleKeys = collectCards();
    renderToolbar(visibleKeys);
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
    const total = registryRecords().length;
    if (!total) {
      alert('Il registro Ali Parser e gia vuoto.');
      return;
    }

    const confirmed = confirm(
      `Stai per cancellare definitivamente ${total} prodotti dal database locale di Ali Parser, incluse note e stati. Questa operazione non puo essere annullata.\n\nVuoi continuare?`
    );
    if (!confirmed) return;

    GM_deleteValue(STORE_KEY);
    refreshUi();
  }

  function installStyles() {
    if (document.querySelector(`[${UI_ATTR}="styles"]`)) return;

    const style = document.createElement('style');
    style.setAttribute(UI_ATTR, 'styles');
    style.textContent = `
      .ap-card-check {
        position: absolute !important;
        top: 8px !important;
        right: 8px !important;
        z-index: 2147483000 !important;
        min-width: 34px !important;
        height: 34px !important;
        padding: 0 8px !important;
        border: 2px solid #111 !important;
        border-radius: 7px !important;
        background: rgba(255,255,255,.96) !important;
        box-shadow: 0 2px 10px rgba(0,0,0,.28) !important;
        color: #111 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 5px !important;
        pointer-events: auto !important;
        font: 900 12px/1 Arial, sans-serif !important;
        white-space: nowrap !important;
      }
      .ap-card-check:hover { transform: scale(1.05) !important; }
      .ap-card-check.ap-new { width: 34px !important; padding: 0 !important; background: rgba(255,255,255,.96) !important; border-color: #111 !important; }
      .ap-card-check.ap-flagged { background: #d47a00 !important; border-color: #9e5900 !important; color: #fff !important; }
      .ap-card-check.ap-parsed { background: #16813f !important; border-color: #0d5f2c !important; color: #fff !important; }
      .ap-card-check.ap-viewed { background: #fff !important; border-color: #2769ad !important; color: #2769ad !important; }
      .ap-checkmark { display: block !important; font-size: 19px !important; line-height: 1 !important; color: currentColor !important; }
      .ap-card-label { display: block !important; font-size: 10px !important; letter-spacing: .2px !important; color: currentColor !important; }

      .ap-card-note {
        position: absolute !important;
        top: 50px !important;
        right: 8px !important;
        z-index: 2147482999 !important;
        max-width: min(230px, calc(100% - 16px)) !important;
        box-sizing: border-box !important;
        padding: 6px 8px !important;
        border: 1px solid #b68a00 !important;
        border-radius: 7px !important;
        background: rgba(255,246,190,.97) !important;
        color: #3c3100 !important;
        box-shadow: 0 2px 9px rgba(0,0,0,.18) !important;
        font: 700 11px/1.3 Arial, sans-serif !important;
        white-space: normal !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 3 !important;
        -webkit-box-orient: vertical !important;
        pointer-events: none !important;
      }
      .ap-card-note-empty { display: none !important; }

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
      .ap-tb-noted { color: #ffe89a !important; }
      .ap-toolbar-registry {
        margin-left: 3px !important;
        padding: 6px 9px !important;
        border: 1px solid #777 !important;
        border-radius: 7px !important;
        background: #fff !important;
        color: #111 !important;
        cursor: pointer !important;
        font: 800 11px/1 Arial, sans-serif !important;
      }

      .ap-product-panel {
        position: fixed !important;
        top: 86px !important;
        right: 18px !important;
        z-index: 2147483646 !important;
        width: 270px !important;
        box-sizing: border-box !important;
        padding: 13px !important;
        border: 2px solid #111 !important;
        border-radius: 12px !important;
        background: #fff !important;
        color: #111 !important;
        box-shadow: 0 7px 28px rgba(0,0,0,.32) !important;
        font: 13px/1.3 Arial, sans-serif !important;
      }
      .ap-panel-head { display: flex !important; align-items: center !important; justify-content: space-between !important; gap: 8px !important; margin-bottom: 8px !important; }
      .ap-panel-title { font-size: 15px !important; font-weight: 800 !important; }
      .ap-panel-status { display: inline-block !important; margin-bottom: 10px !important; padding: 4px 8px !important; border-radius: 999px !important; font-weight: 800 !important; background: #eee !important; }
      .ap-panel-status.ap-parsed { background: #d9f5e3 !important; color: #0d5f2c !important; }
      .ap-panel-status.ap-flagged { background: #fff0d7 !important; color: #8a4b00 !important; }
      .ap-panel-status.ap-viewed { background: #e0efff !important; color: #1c568f !important; }
      .ap-panel-check-row {
        display: flex !important;
        align-items: center !important;
        gap: 9px !important;
        margin: 3px 0 10px !important;
        cursor: pointer !important;
        font-weight: 700 !important;
      }
      .ap-panel-check-row input {
        width: 22px !important;
        height: 22px !important;
        accent-color: #d47a00 !important;
        cursor: pointer !important;
      }
      .ap-product-panel button {
        width: 100% !important;
        box-sizing: border-box !important;
        margin-top: 6px !important;
        padding: 8px 10px !important;
        border-radius: 7px !important;
        cursor: pointer !important;
        font: 700 12px/1.2 Arial, sans-serif !important;
      }
      .ap-product-panel .ap-panel-registry {
        width: auto !important;
        margin: 0 !important;
        padding: 5px 8px !important;
        border: 1px solid #aaa !important;
        background: #f5f5f5 !important;
        color: #222 !important;
      }
      .ap-panel-parsed { border: 0 !important; background: #16813f !important; color: #fff !important; }
      .ap-panel-reset { border: 1px solid #bbb !important; background: #fff !important; color: #444 !important; }
      .ap-panel-note-separator { height: 1px !important; margin: 13px 0 11px !important; background: #ddd !important; }
      .ap-panel-note-label { display: block !important; margin-bottom: 5px !important; font-weight: 800 !important; }
      .ap-panel-note {
        width: 100% !important;
        min-height: 86px !important;
        box-sizing: border-box !important;
        padding: 8px 9px !important;
        border: 1px solid #aaa !important;
        border-radius: 7px !important;
        background: #fffdf1 !important;
        color: #111 !important;
        resize: vertical !important;
        font: 12px/1.35 Arial, sans-serif !important;
      }
      .ap-panel-note:focus { outline: 2px solid #d5a500 !important; outline-offset: 1px !important; }
      .ap-panel-note-help { margin-top: 5px !important; color: #666 !important; font-size: 10px !important; line-height: 1.3 !important; }
      .ap-panel-note-save { border: 1px solid #b68a00 !important; background: #fff0a6 !important; color: #382c00 !important; }

      .ap-registry-overlay {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 22px !important;
        box-sizing: border-box !important;
        background: rgba(0,0,0,.58) !important;
        font-family: Arial, sans-serif !important;
      }
      .ap-registry-modal {
        width: min(980px, 96vw) !important;
        max-height: 90vh !important;
        display: flex !important;
        flex-direction: column !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        border: 1px solid #222 !important;
        border-radius: 14px !important;
        background: #fff !important;
        color: #111 !important;
        box-shadow: 0 20px 70px rgba(0,0,0,.4) !important;
      }
      .ap-registry-head {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 16px !important;
        padding: 18px 20px 12px !important;
        border-bottom: 1px solid #e2e2e2 !important;
      }
      .ap-registry-title-line { display: flex !important; align-items: center !important; gap: 9px !important; flex-wrap: wrap !important; }
      .ap-registry-heading { font-size: 20px !important; line-height: 1.2 !important; font-weight: 900 !important; }
      .ap-registry-total {
        display: inline-block !important;
        padding: 3px 7px !important;
        border: 1px solid #ddd !important;
        border-radius: 999px !important;
        background: #f7f7f7 !important;
        color: #777 !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
      }
      .ap-registry-subtitle { margin-top: 3px !important; color: #666 !important; font-size: 12px !important; }
      .ap-registry-close {
        width: 36px !important;
        height: 36px !important;
        border: 0 !important;
        border-radius: 8px !important;
        background: #eee !important;
        color: #111 !important;
        cursor: pointer !important;
        font: 700 25px/1 Arial, sans-serif !important;
      }
      .ap-registry-controls {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 150px auto !important;
        gap: 10px !important;
        padding: 12px 20px 8px !important;
      }
      .ap-registry-search,
      .ap-registry-filter {
        width: 100% !important;
        box-sizing: border-box !important;
        padding: 10px 11px !important;
        border: 1px solid #aaa !important;
        border-radius: 8px !important;
        background: #fff !important;
        color: #111 !important;
        font: 13px/1.2 Arial, sans-serif !important;
      }
      .ap-registry-copy {
        padding: 10px 13px !important;
        border: 1px solid #222 !important;
        border-radius: 8px !important;
        background: #222 !important;
        color: #fff !important;
        cursor: pointer !important;
        font: 800 12px/1.2 Arial, sans-serif !important;
        white-space: nowrap !important;
      }
      .ap-registry-count { padding: 0 20px 9px !important; color: #777 !important; font-size: 10px !important; }
      .ap-registry-list { overflow: auto !important; padding: 0 20px 20px !important; }
      .ap-registry-row {
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) auto !important;
        gap: 14px !important;
        align-items: start !important;
        padding: 14px 0 !important;
        border-top: 1px solid #eee !important;
      }
      .ap-registry-row:first-child { border-top: 0 !important; }
      .ap-registry-row-main { min-width: 0 !important; }
      .ap-registry-row-top { display: flex !important; gap: 8px !important; align-items: center !important; min-width: 0 !important; }
      .ap-registry-status {
        flex: 0 0 auto !important;
        padding: 3px 7px !important;
        border-radius: 999px !important;
        background: #eee !important;
        font-size: 10px !important;
        font-weight: 900 !important;
        text-transform: uppercase !important;
      }
      .ap-registry-status.ap-parsed { background: #d9f5e3 !important; color: #0d5f2c !important; }
      .ap-registry-status.ap-flagged { background: #fff0d7 !important; color: #8a4b00 !important; }
      .ap-registry-status.ap-viewed { background: #e0efff !important; color: #1c568f !important; }
      .ap-registry-title {
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font-size: 13px !important;
      }
      .ap-registry-url {
        display: block !important;
        margin-top: 6px !important;
        overflow: hidden !important;
        color: #245a9a !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        text-decoration: none !important;
        font: 11px/1.25 ui-monospace, SFMono-Regular, Consolas, monospace !important;
      }
      .ap-registry-url:hover { text-decoration: underline !important; }
      .ap-registry-url-missing { color: #999 !important; }
      .ap-registry-note {
        margin-top: 8px !important;
        padding: 8px 10px !important;
        border: 1px solid #dec45a !important;
        border-radius: 7px !important;
        background: #fff9d9 !important;
        color: #332900 !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
        font-size: 12px !important;
        line-height: 1.35 !important;
      }
      .ap-registry-note-empty { border-color: #e5e5e5 !important; background: #fafafa !important; color: #999 !important; font-style: italic !important; }
      .ap-registry-meta { margin-top: 5px !important; color: #999 !important; font-size: 10px !important; }
      .ap-registry-open {
        align-self: center !important;
        padding: 8px 11px !important;
        border-radius: 7px !important;
        background: #111 !important;
        color: #fff !important;
        text-decoration: none !important;
        font-size: 11px !important;
        font-weight: 800 !important;
      }
      .ap-registry-empty { padding: 30px 0 !important; color: #777 !important; text-align: center !important; font-size: 13px !important; }

      @media (max-width: 720px) {
        .ap-registry-overlay { padding: 8px !important; }
        .ap-registry-modal { width: 100% !important; max-height: 94vh !important; }
        .ap-registry-controls { grid-template-columns: 1fr !important; }
        .ap-registry-row { grid-template-columns: 1fr !important; }
        .ap-registry-open { justify-self: start !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function scheduleScan(delay = 300) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      const visibleKeys = collectCards();
      if (!isProductPage()) {
        renderToolbar(visibleKeys);
      }
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
      setTimeout(handlePage, 250);
    }, 600);
  }

  GM_addValueChangeListener(STORE_KEY, () => refreshUi());
  GM_registerMenuCommand('Ali Parser: apri registro', openRegistryModal);
  GM_registerMenuCommand('Ali Parser: esporta registro JSON', exportRegistry);
  GM_registerMenuCommand('Ali Parser: cancella registro (stati + note)', resetRegistry);

  installStyles();
  installNavigationGuard();
  installKeyboardShortcuts();
  startObserver();
  watchUrlChanges();
  handlePage();
  setTimeout(handlePage, 1000);
  setTimeout(handlePage, 2500);
})();
