# Ali Parser

Userscript Tampermonkey per lavorare metodicamente sui risultati AliExpress senza analizzare due volte lo stesso listing.

## Funzioni attuali

- identifica i prodotti tramite `productId`
- mostra un badge su ogni card dei risultati
- stati distinti: `NUOVO`, `VISTO`, `FLAG`, `PARSATO`
- flag manuale direttamente dalla card
- marcatura manuale come parsato
- avviso prima di riaprire un prodotto gia `PARSATO` o `FLAG`
- persistenza degli stati tra ricerche e sessioni tramite storage Tampermonkey
- supporto allo scroll infinito tramite `MutationObserver`
- pannello nella pagina prodotto per cambiare rapidamente stato
- contatore dei prodotti visibili per stato
- esportazione del registro in JSON dal menu Tampermonkey
- azzeramento completo del registro dal menu Tampermonkey

## Installazione

1. Installa Tampermonkey.
2. Apri `ali-parser.user.js` dal repository.
3. Copia il contenuto in un nuovo userscript Tampermonkey e salvalo.
4. Apri una pagina di ricerca AliExpress.

## Significato degli stati

- `○ NUOVO`: prodotto mai gestito.
- `● VISTO`: la pagina prodotto e stata aperta almeno una volta, ma non e stata marcata come completata.
- `⚑ FLAG`: prodotto marcato manualmente come gia gestito/non da riprocessare.
- `✓ PARSATO`: prodotto considerato analizzato.

`FLAG` e `PARSATO` restano volutamente distinti: il primo e una decisione manuale, il secondo rappresenta un parsing completato o una marcatura esplicita come tale.

## Prossimo sviluppo previsto

La struttura dati e gia predisposta per aggiungere il parser del dettaglio prodotto, tra cui:

- vendite/ordini
- store ID e nome store
- prezzo
- rating e recensioni
- varianti
- gallery immagini
- download delle immagini
- deduplicazione immagini
- esportazione CSV/JSON dei dati raccolti

Quando il parser automatico sara aggiunto, lo stato `PARSATO` potra essere impostato automaticamente solo dopo un'estrazione completata con successo.
