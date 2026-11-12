# Copy Launch : launchpad sur Float

Un launchpad qui lance de **vrais coins Float** (Raydium LaunchLab, paires SOL / USDC / actions tokenisées).
Chaque coin est lancé avec `fee_receiver` = **le wallet public du launchpad**.
La part créateur des fees de tous les coins arrive donc dans ce wallet. Le wallet **copie le n°1 du classement FOMO**, et les profits **rachètent et brûlent les coins** au prorata des fees que chacun a générés.

```
utilisateur ──signe──► launch (programme Float) ── fee_receiver ──► WALLET PUBLIC
                                                                      │ part créateur (5 % des fees Float, dans la paire)
                                                                      ▼
                                                        conversion en SOL (Jupiter)
                                                                      ▼
                                                    copy-trading du top FOMO (garde-fous)
                                                                      ▼ profits réalisés × 80 %
                                                buyback des coins au prorata de leurs fees ─► burn
```

## Ce qui a été vérifié sur mainnet (12/11/2026)
- `npm run verify:float` reproduit **à l'identique les 23 comptes** d'un vrai lancement Float, avec le même format de données (180 octets).
- **La simulation d'un lancement construit par ce code passe** sur le programme Float, avec un `fee_receiver` différent du créateur.
- La config Float est lue on-chain : lancements actifs ; répartition holders 15 %, **créateur 5 %**, flagship 30 %, traders 30 %, trésorerie 20 %.
- Paires activées : SOL, USDC et les xStocks (NVDAx, TSLAx, SPYx, AAPLx…). La liste est relue on-chain au démarrage.
- La part créateur est versée au `fee_receiver` par `claim_dev_fees`, une instruction permissionless que le crank de Float exécute en continu.

Float n'a **pas d'IDL publique**. Le format a été reconstitué à partir des transactions on-chain. Le programme est upgradable : s'il change, `checkFloatConfig()` bloque les lancements au lieu d'envoyer une transaction cassée. Relance `npm run verify:float` après toute mise à jour de Float.

## Architecture
| Partie | Fichier | Rôle |
|---|---|---|
| Client Float | `src/float.ts` | construit l'instruction `launch`, décode la config et les `LaunchState` |
| Site + API | `src/server.ts`, `public/` | formulaire de lancement (Phantom, Solflare, Backpack), hébergement des métadonnées, registre des coins, dashboard public |
| Moteur | `src/engine/` | attribution des fees par coin, conversion en SOL, copy-trading FOMO, buyback et burn |

Le **serveur web ne détient aucune clé**. L'utilisateur signe le lancement dans son wallet, et chaque transaction est **simulée avant signature**. Seul le moteur (process séparé) a la clé du wallet public.

## Lancer
```bash
npm install
cp .env.example .env        # FEE_RECEIVER, BOT_PRIVATE_KEY, RPC_URL, PUBLIC_URL, TRADERS
npm run verify:float        # vérifie la compatibilité avec le programme Float actuel
npm run start:web           # le site
npm run start:engine        # le moteur (DRY_RUN=true par défaut)
npm test
```
`PUBLIC_URL` doit être l'URL HTTPS publique du site, car les métadonnées des coins y sont hébergées. Garde le dossier `data/` sauvegardé : il contient les images et métadonnées des coins.

## Combien ça rapporte
La part créateur vaut 5 % du fee Float. Pour 100 000 $ de volume sur un coin :
| Palier | Fee Float (hors 0,25 % Raydium) | Part créateur → wallet |
|---|---|---|
| 1 % | 0,75 % | ≈ 37,5 $ |
| 2 % | 1,75 % | ≈ 87,5 $ |
| 2,5 % | 2,25 % | ≈ 112,5 $ |

Ces montants viennent de la config on-chain, mais l'arrondi exact de Float n'a pas été vérifié. Il faut **beaucoup de volume cumulé** sur les coins du launchpad pour que le wallet ait un capital de trading utile.

## Le n°1 FOMO, trouvé automatiquement
`src/engine/leaderboard.ts` lit le classement FOMO (fenêtre `LEADERBOARD_WINDOW`, 24h par défaut), prend le n°1 qui a une adresse Solana connue et l'enregistre dans `data/leader.json`. Le moteur le relit au démarrage puis **toutes les 5 h** (`LEADER_SCAN_HOURS`) :
- même n°1 : rien ne change ;
- nouveau n°1 : le moteur s'abonne à sa nouvelle adresse et n'achète plus que derrière lui. L'ancien n°1 reste suivi **uniquement pour revendre** les positions encore ouvertes copiées sur lui (le stop-loss et la prise de profit restent actifs).

`npm run leader` affiche le n°1 actuel. fomo.family n'a pas d'API publique : le classement vient d'une API tierce non officielle (`fomo-api.com` par défaut, board « fomo-parity » = les chiffres tels que FOMO les affiche). Sans clé, elle renvoie le top 10, ce qui suffit pour le n°1. Si le classement est injoignable, le moteur garde le dernier n°1 connu.

## Limites et risques
- **Le classement vient d'une API tierce non officielle** : si elle tombe ou change de format, le moteur garde le dernier n°1 connu et le signale dans les logs. `TRADER_SOURCE=env` permet de repasser sur une liste fixe.
- Le copieur entre toujours après le trader, donc à un moins bon prix, et un wallet public peut être copié à son tour. **Le wallet peut perdre.**
- Float peut mettre les lancements en pause, changer la répartition ou mettre à jour son programme.
- Le site est une interface indépendante : n'utilise pas la marque Float comme si c'était la tienne.
- Pas de redistribution des profits aux holders : risque de qualification en titre financier. Le burn est plus sûr.

## Hébergement
Le projet a deux processus :

| Processus | Commande | Ce qu'il lui faut |
|---|---|---|
| Site + API | `npm run start:web` | Node 20+, écriture disque (`DATA_DIR` : métadonnées, images, registre des coins) |
| Moteur de copy-trading | `npm run start:engine` | Node 20+, tourne en continu (WebSocket Solana, scan FOMO toutes les 5 h), clé du wallet public |

**Cloudflare** : Pages et Workers ne font pas tourner un process Node permanent, n'ont pas de disque, et coupent les tâches longues. En l'état :
- le **site** peut y aller seulement après adaptation : l'API vers des Workers, les fichiers vers R2 et le registre vers D1 ou KV ;
- le **moteur** a besoin d'une machine qui tourne en continu : Railway, Fly.io, Render ou un petit VPS. Avec Cloudflare, la solution simple est un VPS (ou un Cloudflare Container) pour le moteur, et le site sur le même VPS derrière le proxy Cloudflare.

Ne mets jamais `.env` ni la clé du wallet dans le dépôt : configure `BOT_PRIVATE_KEY` comme secret chez l'hébergeur.
