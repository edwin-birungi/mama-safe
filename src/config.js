'use strict';
// All configuration comes from environment variables. See .env.example.
const env = process.env;

module.exports = {
  port: Number(env.PORT) || 3000,
  dbPath: env.MAMASAFE_DB || 'data/mamasafe.db',
  // "production" refuses to load sample facilities and requires a dashboard password.
  env: env.MAMASAFE_ENV || 'development',
  countryCode: env.DEFAULT_COUNTRY_CODE || '256',
  emergencyNumber: env.EMERGENCY_NUMBER || '999',
  ussdCode: env.USSD_CODE || '*123#',
  smsNumber: env.SMS_NUMBER || '',
  // Africa's Talking (https://africastalking.com). Without these, SMS runs in dry-run mode:
  // messages are written to the outbox table and shown on the dashboard but not sent.
  at: {
    username: env.AT_USERNAME || '',
    apiKey: env.AT_API_KEY || '',
    senderId: env.AT_SENDER_ID || '',
    sandbox: env.AT_SANDBOX === 'true'
  },
  dashboard: { user: env.DASHBOARD_USER || 'admin', pass: env.DASHBOARD_PASS || '' },
  // If set, /ussd and /sms/inbound require ?key=<value> (put it in the callback URLs).
  webhookKey: env.WEBHOOK_KEY || '',
  // Hour range (East Africa Time) in which reminder SMS may be sent.
  reminderFromHour: Number(env.REMINDER_FROM_HOUR) || 8,
  reminderToHour: Number(env.REMINDER_TO_HOUR) || 19,
  utcOffsetHours: Number(env.UTC_OFFSET_HOURS || 3)
};
