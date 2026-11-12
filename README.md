# Copy Launch : launchpad sur Float, 100 % Cloudflare

Un launchpad qui lance de **vrais coins Float** (Raydium LaunchLab ; paires SOL, USDC et actions tokenisées).
Chaque coin est lancé avec `fee_receiver` = **le wallet public du launchpad**. La part créateur des fees (5 % du fee Float) arrive donc dans ce wallet. Le wallet **copie le n°1 du classement FOMO**, et les profits **rachètent et brûlent les coins** au prorata des fees que chacun a générés.

```
utilisateur ──signe──► launch (programme Float) ── fee_receiver ──► WALLET PUBLIC
                                                                      │ part créateur, dans la paire du coin
                                                     cron horaire ──► conversion en SOL (Jupiter)
                                                                      ▼
                     cron toutes les 5 h : n°1 FOMO ──► copy-trading (Durable Object, alarme toutes les 10 s)
                                                                      ▼ profits réalisés × 80 %
                                                     rachat des coins au prorata de leurs fees ─► burn
```

## Architecture Cloudflare
| Brique | Service | Fichier |
|---|---|---|
| Site | Workers Static Assets | `public/` |
| API : lancement, paires, stats, trader | Worker | `src/worker.ts` |
| Images et fiches des coins (`/img`, `/m`) | R2 `copy-launch-files` | `src/worker.ts` |
| Registre des coins | D1 `copy-launch` | `migrations/` |
| Moteur de copy-trading | Durable Object `CopyEngine` (alarmes) | `src/engine.ts` |
| Scan du n°1 FOMO (5 h), conversion des fees (1 h) | Cron Triggers | `wrangler.toml` |
| Client du programme Float | | `src/float.ts` |

Le Worker ne signe jamais rien : l'utilisateur signe son lancement dans son wallet, et chaque lancement est **simulé avant signature**. Seul le moteur utilise `BOT_PRIVATE_KEY`, stockée en secret Cloudflare.

## Déploiement
```bash
npm install
npx wrangler login
npx wrangler d1 create copy-launch                 # copier l'id dans wrangler.toml (database_id)
npx wrangler r2 bucket create copy-launch-files
npm run db:migrate
npx wrangler secret put RPC_URL                    # RPC payant conseillé (Helius, Triton…)
npx wrangler secret put BOT_PRIVATE_KEY            # clé base58 du wallet FEE_RECEIVER
npx wrangler secret put ADMIN_TOKEN                # mot de passe pour piloter le moteur
npm run deploy
```
Ensuite :
1. Dans `wrangler.toml`, `FEE_RECEIVER` doit être l'adresse du wallet dont tu as mis la clé.
2. Ajoute ton domaine au Worker (Settings → Domains & Routes).
3. Si tu sers le site sur un domaine précis, mets `PUBLIC_URL` dans `[vars]` : c'est l'adresse écrite dans les fiches des coins.

## Piloter le moteur (en pause par défaut)
```bash
curl -X POST https://TON-DOMAINE/api/admin/engine -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"action":"start"}'
```
Actions possibles : `start`, `pause`, `scan` (relire le n°1 FOMO maintenant), `fees` (cycle des fees maintenant).
`DRY_RUN = "true"` (dans `wrangler.toml`) simule tous les trades. Passe-le à `"false"` seulement après une période de test.

## Le n°1 FOMO
fomo.family n'a pas d'API publique. Le classement est lu via une API tierce non officielle (`fomo-api.com` par défaut, board « fomo-parity » = les chiffres tels que FOMO les affiche) :
- le moteur prend le n°1 qui a une adresse Solana connue ;
- il le revérifie toutes les 5 h. Si le n°1 change, il ne copie plus que le nouveau, et suit l'ancien uniquement pour revendre ses positions encore ouvertes ;
- si l'API est injoignable, il garde le dernier n°1 connu.

Réglages : `LEADERBOARD_WINDOW` (24h, 7d ou 30d), `MODE` (TOP1 ou BASKET), `BASKET_SIZE`, `FOMO_API_KEY`.

## Garde-fous du copy-trading
- taille max par trade : `MAX_POSITION_PCT` ;
- nombre max de positions ouvertes ;
- tokens refusés si leur mint authority ou leur freeze authority est active ;
- impact prix max, plus un test de revente avant chaque achat ;
- stop-loss et prise de profit ;
- pause automatique si la perte du jour dépasse `MAX_DAILY_LOSS_PCT` ;
- les coins du launchpad ne sont jamais copy-tradés.

## Développement local
```bash
cp .dev.vars.example .dev.vars    # puis remplir
npx wrangler d1 migrations apply copy-launch --local
npm run dev                       # http://localhost:8787
npm test                          # détection des swaps
npm run verify:float              # compatibilité avec le programme Float actuel (lecture et simulation mainnet)
```

## Programme Float
Float n'a pas d'IDL publique. Le format de l'instruction `launch` a été reconstitué à partir des transactions on-chain, et `npm run verify:float` le vérifie contre un vrai lancement. Le programme est modifiable par Float : s'il change, `checkFloatConfig()` bloque les lancements au lieu d'envoyer une transaction cassée.

## Coût et risques
- Le wallet reçoit environ 0,0375 SOL (fee à 1 %) à 0,1125 SOL (fee à 2,5 %) pour 100 SOL échangés sur un coin. Il faut beaucoup de volume pour que le copy-trading ait un capital utile.
- Le copieur entre toujours après le trader, donc à un moins bon prix, et un wallet public peut lui-même être copié. **Le wallet peut perdre.** Aucun profit n'est promis.
- Le classement vient d'une API tierce non officielle.
- Le site est une interface indépendante, sans lien officiel avec Float, Raydium ou FOMO.
