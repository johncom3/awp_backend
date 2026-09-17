# awp_backend

Backend für den Aktion-Weihnachtspäckli-Schichtplan.

## Lokal starten

```bash
npm install
cp .env.example .env
npm run dev
```

Ohne `DATABASE_URL` startet der Server mit einem In-Memory-Speicher. Für Railway sollte PostgreSQL über `DATABASE_URL` verbunden werden.

## Railway

Dieses Verzeichnis ist ein eigenes Git-Repository. In Railway deshalb:

- Service Source: `johncom3/awp_backend`
- Root Directory: leer lassen bzw. `/`
- Start Command: automatisch über `npm run start`

Empfohlene Variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
SHIFTPLAN_PASSWORD=dein-passwort
SESSION_SECRET=ein-langer-zufallswert
FRONTEND_ORIGIN=https://deine-frontend-domain.up.railway.app
```

Die initialen Schichten stehen in `shifts.seed.json`. Wenn die Tabelle in PostgreSQL leer ist, werden diese Schichten beim ersten Start automatisch eingetragen.
