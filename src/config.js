'use strict';
// All configuration comes from environment variables. See .env.example.
const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  dbPath: env.MAMASAFE_DB || 'data/mamasafe.db',
  // "production" requires a dashboard password and hides development-only helpers.
  env: env.MAMASAFE_ENV || 'development',
  countryCode: env.DEFAULT_COUNTRY_CODE || '256',
  emergencyNumber: env.EMERGENCY_NUMBER || '999',
  ussdCode: env.USSD_CODE || '*123#',
  smsNumber: env.SMS_NUMBER || '',
  // UGSMS (https://sms.ugmail.co), the main way MamaSafe sends SMS in Uganda. Mothers see the sender name
  // (senderId, up to 11 letters or digits) instead of a number. The name must be approved on your UGSMS account.
  ugsms: {
    apiKey: env.UGSMS_API_KEY || '',
    senderId: (env.UGSMS_SENDER_ID || 'MamaSafe').slice(0, 11),
    baseUrl: (env.UGSMS_BASE_URL || 'https://sms.ugmail.co/api/v1').replace(/\/+$/, '')
  },
  // Africa's Talking (https://africastalking.com). Still used for USSD and for texts mothers send in, and as a
  // backup for sending if UGSMS is not set up. Without these, SMS runs in dry-run mode:
  // messages are written to the outbox table and shown on the dashboard but not sent.
  at: {
    username: env.AT_USERNAME || '',
    apiKey: env.AT_API_KEY || '',
    senderId: env.AT_SENDER_ID || '',
    sandbox: env.AT_SANDBOX === 'true'
  },
  // Google Maps JavaScript API key (restrict it to your site's referrer in Google Cloud). Without it the
  // app falls back to OpenStreetMap, and every facility still has a Google Maps directions link.
  googleMapsKey: env.GOOGLE_MAPS_API_KEY || '',
  googleMapId: env.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
  // Reverse geocoding is only requested after a user explicitly shares location.
  // Keep this configurable so the lookup provider can be changed without a code update.
  reverseGeocoderUrl: env.REVERSE_GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse',
  // Optional enrolment fee. 0 = free for everyone (payments off). Emergency alerts, the danger-sign
  // check and the hospital finder are ALWAYS free whatever this is set to.
  payments: {
    fee: Number(env.ENROLMENT_FEE) || 0,
    currency: env.PAYMENT_CURRENCY || 'UGX',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),           // https://your-domain, used for the return link
    flwSecretKey: env.FLW_SECRET_KEY || '',                           // Flutterwave secret key (test or live)
    flwSecretHash: env.FLW_SECRET_HASH || '',                         // the "secret hash" you set for webhooks
    options: env.PAYMENT_OPTIONS || 'card,mobilemoneyuganda',
    emailDomain: env.PAYMENT_EMAIL_DOMAIN || 'example.com',           // Flutterwave needs an email; mothers rarely have one
    // MTN MoMo Collections ("Request to Pay"): a prompt appears on the mother's own phone and she
    // approves it with her MoMo PIN. Works from USSD and SMS, no browser needed.
    momo: {
      subscriptionKey: env.MOMO_SUBSCRIPTION_KEY || '',               // Ocp-Apim-Subscription-Key for the Collection product
      apiUser: env.MOMO_API_USER || '',
      apiKey: env.MOMO_API_KEY || '',
      targetEnv: env.MOMO_TARGET_ENV || 'sandbox',                    // "sandbox" while testing, "mtnuganda" in production
      baseUrl: (env.MOMO_BASE_URL || ((env.MOMO_TARGET_ENV || 'sandbox') === 'sandbox' ? 'https://sandbox.momodeveloper.mtn.com' : 'https://proxy.momoapi.mtn.com')).replace(/\/+$/, ''),
      callbackKey: env.MOMO_CALLBACK_KEY || ''                        // secret in the callback URL (MTN does not sign callbacks)
    },
    // Airtel Money collections ("USSD push"): same idea, for Airtel numbers.
    airtel: {
      clientId: env.AIRTEL_CLIENT_ID || '',
      clientSecret: env.AIRTEL_CLIENT_SECRET || '',
      targetEnv: env.AIRTEL_ENV || 'sandbox',                         // "sandbox" or "production"
      baseUrl: (env.AIRTEL_BASE_URL || ((env.AIRTEL_ENV || 'sandbox') === 'production' ? 'https://openapi.airtel.africa' : 'https://openapiuat.airtel.africa')).replace(/\/+$/, ''),
      country: env.AIRTEL_COUNTRY || 'UG',
      callbackKey: env.AIRTEL_CALLBACK_KEY || ''
    }
  },
  // Demo / developer access for remote testers (see src/demo.js). Both must be set. The code must be 8+ characters.
  demo: { code: env.DEMO_CODE || '', phones: env.DEMO_PHONES || '' },
  // Emergency transport. When an alert is raised, the nearest registered drivers are sent a pickup SMS.
  transport: {
    autoDispatch: env.TRANSPORT_AUTO_DISPATCH !== 'false',
    dispatchCount: Number(env.TRANSPORT_DISPATCH_COUNT) || 3   // how many drivers are asked per alert
  },
  dashboard: { user: env.DASHBOARD_USER || 'admin', pass: env.DASHBOARD_PASS || '', inviteCode: env.STAFF_INVITE_CODE || '' },
  // If set, /ussd and /sms/inbound require ?key=<value> (put it in the callback URLs).
  webhookKey: env.WEBHOOK_KEY || '',
  // Hour range (East Africa Time) in which reminder SMS may be sent.
  reminderFromHour: Number(env.REMINDER_FROM_HOUR) || 8,
  reminderToHour: Number(env.REMINDER_TO_HOUR) || 19,
  utcOffsetHours: Number(env.UTC_OFFSET_HOURS || 3)
};
