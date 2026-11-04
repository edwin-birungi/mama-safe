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
npm test       # 71 tests
```

On first start (development mode) it loads **22 real Ugandan hospitals** (`seed/facilities.uganda.csv`, see *Facility data* below) and runs SMS in **dry-run mode**: every message is recorded and visible in the dashboard's *Messages* tab, but nothing is actually sent. The sign-in code is shown on screen in development mode.

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
3. **Facility data and Google Maps.** See the next section.
4. **Host it.** Any small server works. `Dockerfile` included. Put it behind HTTPS (Caddy, nginx, a platform's built-in TLS), set `TRUST_PROXY=true`, mount `data/` on persistent storage and **back it up**.
5. **Set the environment** (see `.env.example`): `MAMASAFE_ENV=production`, `GOOGLE_MAPS_API_KEY`, `DASHBOARD_PASS`, `WEBHOOK_KEY`, `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `USSD_CODE`, `SMS_NUMBER`.
6. Test with the Africa's Talking **sandbox** (`AT_SANDBOX=true`) and a USSD simulator before real mothers use it.

## Facility data, Google Maps and contact numbers

**Find a hospital near me.** The *Find a hospital* screen works without signing in (button on the sign-in page; also *Care* in the app). It sorts by distance from the phone's GPS, searches by district or name, filters by hospital / health centre / clinic / open 24 hours, and shows a map with numbered pins. Every facility has tap-to-call buttons for each number we hold (main line, **emergency line**, **toll-free line**), a Google Maps directions link, and website/email when known. On USSD dial the menu's *Find a hospital*; by SMS text `CLINICS Gulu`.

**Google Maps.** Create a Maps JavaScript API key in Google Cloud, restrict it to your site's referrer (HTTP referrers), and set `GOOGLE_MAPS_API_KEY` (and optionally a Map ID in `GOOGLE_MAP_ID`; the default `DEMO_MAP_ID` is for testing). The app then uses Google Maps with advanced markers. Without a key, or if Google fails to load, it falls back to OpenStreetMap (Leaflet), and every facility still has a "Directions" link that opens Google Maps with no key. Google bills by usage; check their current pricing.

**What is in the box (honest summary).** `seed/facilities.uganda.csv` holds 22 real hospitals (national and regional referral hospitals plus a few large private ones). Coordinates are mostly from Wikipedia (about 100 m accuracy at best). Contact numbers were collected from official hospital and directory pages and each row carries `contact_confidence` (`medium`, `low`, `none`), a `source` and `researched_on`. **Most rows have no phone number because none could be confirmed**; the app shows "No phone number on file" rather than guessing. Only Mulago has a facility toll-free line. `seed/helplines.json` lists national lines (999, 112, Uganda Red Cross 0800 211 088, Reproductive Health Uganda 0800 299 003) with sources; Ministry of Health lines seen only in 2020 sources are deliberately left out until confirmed. **Call every number before launch**, then re-check every few months.

**Health centres and clinics.** There are thousands in Uganda and no single clean public file, so load them from your sources:
```bash
npm run import:facilities -- my-facilities.csv          # Ministry of Health master list, district list, your own
npm run import:facilities -- --osm overpass.json        # OpenStreetMap export
```
CSV columns (aliases such as `facility_name`, `district`, `telephone`, `latitude` are understood): `code,name,kind,level,area,phone,emergency_phone,toll_free,alert_phone,email,website,lat,lng,open24,services`. Only `name` and `area` (district) are required. A phone cell with several numbers is split, and 0800/0801 numbers become the toll-free line. Re-running is safe (matched by code; curated rows win over OSM).
For OpenStreetMap, run this in https://overpass-turbo.eu (export as JSON) for Uganda, then import the file (data is ODbL, credit OpenStreetMap contributors):
```
[out:json][timeout:180];
area["ISO3166-1"="UG"]->.a;
( nwr["amenity"~"hospital|clinic|doctors"](area.a); nwr["healthcare"~"hospital|clinic|centre"](area.a); );
out center tags;
```

**Emergency alerts need a mobile number.** A hospital's landline or toll-free line cannot receive SMS. Set `alert_phone` (a monitored mobile, ideally the maternity ward's) per facility, via the CSV or the dashboard API (`PATCH /api/admin/facilities/:id`). Until it is set the alert is saved and shown on the dashboard, the mother is told **"we could not message them, please call"** with the facility's numbers, and the dashboard flags the alert as *not sent by SMS*. The app never claims a facility was told unless an SMS really went to it. `alert_phone` and internal notes are never shown publicly. Facilities acknowledge with `ACK <number>` from that mobile only.

## Payments (optional): MTN MoMo, Airtel Money and card

**MTN MoMo and Airtel Money (work on any phone).** The app, USSD (*Pay fee* in the menu) and SMS (`PAY`, or `PAY 0772123456` for another number) ask the mother's operator to put a payment prompt on her phone. She enters her mobile money PIN there. This is the route for mothers without smartphones. The network is chosen from the number's prefix (077/078/076/039 = MTN, 070/074/075 = Airtel); you can enable either or both. If a number has moved networks the operator refuses the prompt and the mother is told by SMS.

Setup (MTN MoMo Open API, Collection product):
1. Sandbox first: subscribe to the *Collection* product at https://momodeveloper.mtn.com to get your subscription key, create an API user and API key (the sandbox portal does this), then set `MOMO_SUBSCRIPTION_KEY`, `MOMO_API_USER`, `MOMO_API_KEY`. Leave `MOMO_TARGET_ENV=sandbox`. **The sandbox only accepts the currency EUR**, so set `PAYMENT_CURRENCY=EUR` while testing.
2. Production: MTN Uganda must approve you as a collections partner. You then create the API user and key in their Partner Portal, and set `MOMO_TARGET_ENV=mtnuganda`, `PAYMENT_CURRENCY=UGX` and the production keys. The base URL switches to `https://proxy.momoapi.mtn.com` automatically.
3. Callback: set `PUBLIC_URL` and a long random `MOMO_CALLBACK_KEY`; prompts then carry `X-Callback-Url: PUBLIC_URL/webhooks/momo/<key>`. MTN does not sign callbacks, so a callback only tells us when to check, and we always ask MTN for the status before crediting. Without callbacks the web app and a status poll still settle payments.

Behaviour: one open prompt per mother at a time (a second tap within 2 minutes re-uses it), the mother gets an SMS when payment is confirmed, and if the operator refuses the prompt she is told by SMS.

**Airtel Money setup** (Airtel Money Open API, collections):
1. Register at the Airtel Africa developer portal, create an application with the *Collection* product, and set `AIRTEL_CLIENT_ID` and `AIRTEL_CLIENT_SECRET`. Start with `AIRTEL_ENV=sandbox` (host `openapiuat.airtel.africa`); production uses `openapi.airtel.africa`. Airtel Uganda must approve your business for live use. The sandbox may require a different currency than UGX: set `PAYMENT_CURRENCY` to what the portal tells you.
2. In the portal set the callback URL to `https://YOUR-DOMAIN/webhooks/airtel/<AIRTEL_CALLBACK_KEY>` and put the same random key in `AIRTEL_CALLBACK_KEY`. As with MTN, a callback is only a hint: we call Airtel's status endpoint before crediting.
3. Flow used: `POST /auth/oauth2/token`, `POST /merchant/v2/payments/` (headers `X-Country: UG`, `X-Currency`), status via `GET /standard/v1/payments/{id}` where `TS` = paid, `TF` = failed, anything else keeps waiting.

---

**Card, and other mobile money, through Flutterwave.**

Off by default. Set `ENROLMENT_FEE` (for example `43000`) and mothers see a **Pay** button on the home screen. It sends them to **Flutterwave's hosted checkout**, where they choose MTN or Airtel mobile money or a card. Card numbers and mobile-money PINs are entered on Flutterwave's page, so this server never handles them.

Set up:
1. Create a Flutterwave account and get your **secret key** (`FLW_SECRET_KEY`). Use test keys first.
2. In the Flutterwave dashboard set the webhook URL to `https://YOUR-DOMAIN/webhooks/flutterwave` and choose a **secret hash**; put the same value in `FLW_SECRET_HASH`.
3. Set `PUBLIC_URL=https://YOUR-DOMAIN` (the return link), `ENROLMENT_FEE`, `PAYMENT_CURRENCY` (default `UGX`) and `PAYMENT_EMAIL_DOMAIN` (Flutterwave requires an email; mothers rarely have one, so we use `<phone>@that-domain`; use a domain you own).
4. Confirm in your Flutterwave account that UGX card payments and Uganda mobile money are enabled for your business.

How it stays safe:
- **Emergency help is never behind payment.** SOS alerts, the danger-sign check and the hospital finder are free for everyone. Only SMS visit reminders wait until a mother has paid or been waived (a test checks that alerts still fire for an unpaid mother).
- **We never trust the browser or the webhook body.** On return and on every webhook we ask Flutterwave directly (`verify_by_reference`) and check the reference, amount and currency against our own record. A payment is credited once. Unsigned webhooks are rejected; without `FLW_SECRET_HASH` the webhook endpoint refuses everything.
- **Waivers.** Staff can cover anyone's fee: `POST /api/admin/mothers/<id>/waive` (dashboard login). Payments are listed at `GET /api/admin/payments`.
- Without keys in development, a built-in **test mode** simulates the payment page. In production without keys, checkout is refused rather than faked.

Limits you should know about:
- **MTN and Airtel are tested only against fakes of their APIs.** I wrote it from MTN's public documentation and developer-community pages (MTN: `/collection/token/`, `POST /collection/v1_0/requesttopay`, `GET /collection/v1_0/requesttopay/{id}`; Airtel: the endpoints above) and public integration guides. Airtel's published details were less complete than MTN's (for example its callback payload and status values). Run both in their sandboxes and check field names against each operator's current documentation before taking real money.
- **Not tested against Flutterwave.** The integration follows their v3 API (`POST /v3/payments`, `GET /v3/transactions/verify_by_reference`, `verif-hash` webhook header) and is tested only against a fake of it. Run their test mode end to end, and check each endpoint against their current documentation, before taking real money. Flutterwave's published page for Uganda mobile money describes a redirect flow; hosted checkout should cover it, but confirm it for your account.
- Fees, refunds, receipts, tax and money-services rules (Bank of Uganda, data protection) are not handled here. Get advice before charging mothers, and think hard about whether a fee suits the mothers who need this most.

## How it works

- **USSD** is stateless: the gateway sends every answer so far (`2*5*1`); we replay it through a small state machine (`src/ussd.js`). Every screen is tested to fit the 182-character limit.
- **Phone number = identity** on USSD and SMS (the network supplies it). The web app proves it with a one-time SMS code.
- **Emergency alert** (`src/alerts.js`): saves an alert, SMSes the facility's alert mobile if it has one (they reply `ACK 12`), SMSes the emergency contact, and confirms to the mother. Repeated taps within 5 minutes do not page twice. Facility choice: nearest **24-hour** facility when GPS is available; otherwise her own facility if it is 24-hour, else a 24-hour one in her area.
- **Reminders** (`src/reminders.js`): 3 days before, 1 day before and on the day of the next visit, 08:00 to 19:00 East Africa time, each sent once. Visits follow the 8-contact WHO schedule (weeks 12, 20, 26, 30, 34, 36, 38, 40).
- **Triage** (`src/triage.js`): danger signs → *emergency*, check-up-soon signs → *urgent*, common symptoms → *mild*.

### SMS keywords
`REG DDMMYY CODE [name]` register (CODE or the number from a CLINICS reply) · `CLINICS district` find care · `VISIT` · `CLINIC` · `SYMPTOM 1 9` · `SOS` · `STOP` / `START` · `HELP`. Facilities reply `ACK <alert number>`.

## Before real mothers use it (please read)

- **Clinical review is required.** The danger-sign list, advice wording and visit schedule are reasonable defaults, not clinical guidance. Have a qualified clinician or the national maternal health programme review and sign off `src/triage.js` and `src/schedule.js`.
- **Live SMS is untested.** The Africa's Talking calls follow their documented API but were not run against a real account (this was built without network access to it). Test in their sandbox first.
- **No ambulance dispatch.** An alert tells the facility, the emergency contact and the mother. It does not book transport. Agree a response protocol with each facility.
- **Facilities must respond.** An alert nobody reads is dangerous. Decide who watches the dashboard and phones, and what happens when an alert is not acknowledged (escalation is not built yet).
- **USSD has no GPS.** Alerts from basic phones carry no coordinates, only her registered facility and area.
- **Languages.** Everything is in English. Add Luganda, Kiswahili and others with native-speaking translators; do not machine-translate medical advice.
- **Health data is sensitive.** Get legal advice on consent and data protection (in Uganda, the Data Protection and Privacy Act 2019), restrict dashboard access, and keep backups encrypted.
- **Maps.** The Google Maps path was tested only against a stand-in for the Google library (I had no key or network access): check it with your own key. The OpenStreetMap fallback loads Leaflet from a CDN; for heavy use self-host it and use a tile provider. The list and call buttons work without any map.
- **Dashboard login** is one shared password. Per-facility accounts, audit logging and unacknowledged-alert escalation are the next things to add.
- Not built yet: visit attendance tracking, postnatal care, health-worker/volunteer accounts, analytics.

## Layout

```
src/            server, USSD, SMS commands, triage, schedule, alerts, reminders
public/         mother web app (PWA) and facility dashboard
seed/           curated Uganda hospitals and national helplines (read-only reference data)
data/           the SQLite file (created on first run)
scripts/        facility importer
test/           35 tests: npm test
```
