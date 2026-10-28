# MamaSafe

Antenatal care for mothers on **any phone**: visit reminders, a danger-sign check, emergency alerts to the nearest facility, and a map of nearby care. It works three ways, all backed by one database:

| Channel | Who it is for | How |
|---|---|---|
| Web app (installable PWA) | Mothers with smartphones | `/` |
| USSD (`*123#`) | Mothers with basic phones, no data | `POST /ussd` |
| SMS keywords | Anyone who can text; health workers | `POST /sms/inbound` |
| Facility dashboard | Midwives and clinic staff | `/dashboard` |

No database server and no `npm install`: it uses Node 22's built-in SQLite and HTTP server.

## Run it in 30 seconds

```bash
node -v        # must be 22.5 or newer
npm start      # http://localhost:3000
npm test       # 35 tests
```

On first start (development mode) it loads six **fake sample facilities** and runs SMS in **dry-run mode**: every message is recorded and visible in the dashboard's *Messages* tab, but nothing is actually sent. The sign-in code is shown on screen in development mode.

Try it:
1. Open `http://localhost:3000`, sign in with any phone number, register.
2. Open `http://localhost:3000/dashboard` in another tab. Press **SOS** in the app. The alert appears; click *I am acting on this*.
3. Simulate a feature phone:
   ```bash
   curl -d 'phoneNumber=+256712345678&text='        localhost:3000/ussd      # main menu
   curl -d 'phoneNumber=+256712345678&text=1'       localhost:3000/ussd      # register
   curl -d 'from=+256712345678&text=HELP'           localhost:3000/sms/inbound
   ```

## Going live

1. **Africa's Talking account** (https://africastalking.com). Create an app, then request:
   - a **USSD code** (shared codes like `*384*xxxx#` are quick to get; a dedicated `*123#`-style code needs the regulator and each network operator),
   - an **SMS shortcode or sender ID**, and ideally **zero-rated / toll-free** replies, otherwise mothers pay to ask for help.
2. **Callback URLs** in the Africa's Talking dashboard (use HTTPS):
   - USSD: `https://YOUR-DOMAIN/ussd?key=YOUR_WEBHOOK_KEY`
   - Incoming SMS: `https://YOUR-DOMAIN/sms/inbound?key=YOUR_WEBHOOK_KEY`
3. **Real facilities.** Replace the samples with your own list (Ministry of Health master facility list, district health office, or OpenStreetMap):
   ```bash
   npm run import:facilities -- my-facilities.csv     # columns: code,name,level,area,phone,lat,lng,open24,services
   ```
   Facility `phone` numbers receive emergency SMS, so they must be monitored 24 hours for the facilities that are marked `open24`.
4. **Host it.** Any small server works. `Dockerfile` included. Put it behind HTTPS (Caddy, nginx, a platform's built-in TLS), set `TRUST_PROXY=true`, mount `data/` on persistent storage and **back it up**.
5. **Set the environment** (see `.env.example`): `MAMASAFE_ENV=production`, `DASHBOARD_PASS`, `WEBHOOK_KEY`, `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `USSD_CODE`, `SMS_NUMBER`.
6. Test with the Africa's Talking **sandbox** (`AT_SANDBOX=true`) and a USSD simulator before real mothers use it.

## How it works

- **USSD** is stateless: the gateway sends every answer so far (`2*5*1`); we replay it through a small state machine (`src/ussd.js`). Every screen is tested to fit the 182-character limit.
- **Phone number = identity** on USSD and SMS (the network supplies it). The web app proves it with a one-time SMS code.
- **Emergency alert** (`src/alerts.js`): saves an alert, SMSes the facility (who can reply `ACK 12`), SMSes the emergency contact, and confirms to the mother. Repeated taps within 5 minutes do not page twice. Facility choice: nearest **24-hour** facility when GPS is available; otherwise her own facility if it is 24-hour, else a 24-hour one in her area.
- **Reminders** (`src/reminders.js`): 3 days before, 1 day before and on the day of the next visit, 08:00 to 19:00 East Africa time, each sent once. Visits follow the 8-contact WHO schedule (weeks 12, 20, 26, 30, 34, 36, 38, 40).
- **Triage** (`src/triage.js`): danger signs → *emergency*, check-up-soon signs → *urgent*, common symptoms → *mild*.

### SMS keywords
`REG DDMMYY CODE [name]` register · `VISIT` · `CLINIC` · `SYMPTOM 1 9` · `SOS` · `STOP` / `START` · `HELP`. Facilities reply `ACK <alert number>`.

## Before real mothers use it (please read)

- **Clinical review is required.** The danger-sign list, advice wording and visit schedule are reasonable defaults, not clinical guidance. Have a qualified clinician or the national maternal health programme review and sign off `src/triage.js` and `src/schedule.js`.
- **Live SMS is untested.** The Africa's Talking calls follow their documented API but were not run against a real account (this was built without network access to it). Test in their sandbox first.
- **No ambulance dispatch.** An alert tells the facility, the emergency contact and the mother. It does not book transport. Agree a response protocol with each facility.
- **Facilities must respond.** An alert nobody reads is dangerous. Decide who watches the dashboard and phones, and what happens when an alert is not acknowledged (escalation is not built yet).
- **USSD has no GPS.** Alerts from basic phones carry no coordinates, only her registered facility and area.
- **Languages.** Everything is in English. Add Luganda, Kiswahili and others with native-speaking translators; do not machine-translate medical advice.
- **Health data is sensitive.** Get legal advice on consent and data protection (in Uganda, the Data Protection and Privacy Act 2019), restrict dashboard access, and keep backups encrypted.
- **Map** loads Leaflet from a CDN and OpenStreetMap tiles. For heavy use, self-host Leaflet and use a tile provider (OpenStreetMap's public tile servers are for light use). The facility list works without the map.
- **Dashboard login** is one shared password. Per-facility accounts, audit logging and unacknowledged-alert escalation are the next things to add.
- Not built yet: visit attendance tracking, postnatal care, health-worker/volunteer accounts, analytics.

## Layout

```
src/            server, USSD, SMS commands, triage, schedule, alerts, reminders
public/         mother web app (PWA) and facility dashboard
data/           sample facilities CSV (fake) and the SQLite file (created on first run)
scripts/        facility importer
test/           35 tests: npm test
```
