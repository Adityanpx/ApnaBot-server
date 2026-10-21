// Mobile push notifications: who gets which event, on which sound channel, in
// which language. Delivery itself is push.service.js.
//
//   notify(businessId, type, payload)   fire-and-forget; never throws, never rejects
//
// Channel ids must match the ones the Flutter app creates (Android notification
// channels, with the bundled voice clips):
//   voice     v1_<type>_<en|hi|mr>   booking_new, enquiry_new, payment_received,
//                                    human_needed, booking_cancelled
//   normal    v1_messages
//   critical  v1_critical
//   silent    v1_silent
const supabase = require('../config/supabase');
const pushService = require('./push.service');
const { istMinuteOfDay } = require('../utils/ist');
const logger = require('../utils/logger');

const LANGUAGES = ['en', 'hi', 'mr'];
const DEFAULT_LANGUAGE = 'en';

const CHANNEL_NORMAL = 'v1_messages';
const CHANNEL_CRITICAL = 'v1_critical';
const CHANNEL_SILENT = 'v1_silent';

const NEW_MESSAGE_THROTTLE_SECONDS = 120;
const CUSTOMER_WAITING_DELAY_MS = 10 * 60 * 1000;

// users.can_* column a staff member needs, per permission group. Critical types
// never go to staff (owner only), so they carry no group.
//   bookings -> can_manage_bookings   messages -> can_view_chats   payments -> can_manage_billing
const PERMISSION_COLUMNS = {
  bookings: 'can_manage_bookings',
  messages: 'can_view_chats',
  payments: 'can_manage_billing'
};

// kind: 'voice' (own sound per language) | 'normal' | 'critical' (owner only, ignores toggles and quiet hours)
// A critical type with voice: true plays its spoken clip (v1_<type>_<lang>) instead of the plain critical channel.
const TYPES = {
  booking_new:       { kind: 'voice', permission: 'bookings' },
  enquiry_new:       { kind: 'voice', permission: 'messages' },
  payment_received:  { kind: 'voice', permission: 'payments' },
  human_needed:      { kind: 'voice', permission: 'messages' },
  booking_cancelled: { kind: 'voice', permission: 'bookings' },
  new_message:       { kind: 'voice', permission: 'messages' },
  customer_waiting:  { kind: 'voice', permission: 'messages' },
  whatsapp_disconnected: { kind: 'critical', voice: true, route: '/business/whatsapp' },
  payment_issue:         { kind: 'critical', voice: true, route: '/business/whatsapp' },
  usage_90:              { kind: 'critical', route: '/subscription/status' },
  usage_100:             { kind: 'critical', voice: true, route: '/subscription/status' },
  plan_expiring:         { kind: 'critical', voice: true, route: '/subscription/status' },
  plan_expired:          { kind: 'critical', voice: true, route: '/subscription/status' },
  quality_dropped:       { kind: 'critical', voice: true, route: '/business/whatsapp' }
};
const TYPE_NAMES = Object.keys(TYPES);

// ── Wording (en/hi/mr, same idea as utils/systemMessages.js) ─────────────────
// {who} = customer name or number, {what} = vehicle/service, {when} = date,
// {amount}, {days}, {preview} are filled from the payload; a line whose value is
// missing falls back to `bodyNoWho` / `body` where given.
const WHO_FALLBACK = { en: 'A customer', hi: 'एक ग्राहक', mr: 'एक ग्राहक' };

const TEXT = {
  booking_new: {
    title: { en: 'New booking', hi: 'नई बुकिंग', mr: 'नवीन बुकिंग' },
    body: { en: 'You have a new booking', hi: 'आपके पास नई बुकिंग है', mr: 'तुम्हाला नवीन बुकिंग मिळाली आहे' }
  },
  enquiry_new: {
    title: { en: 'New enquiry', hi: 'नई पूछताछ', mr: 'नवीन चौकशी' },
    body: { en: 'New enquiry from {who}', hi: '{who} की ओर से नई पूछताछ', mr: '{who} कडून नवीन चौकशी' }
  },
  payment_received: {
    title: { en: 'Payment received', hi: 'भुगतान मिला', mr: 'पेमेंट मिळाले' },
    body: { en: '₹{amount} received from {who}', hi: '{who} से ₹{amount} प्राप्त हुए', mr: '{who} कडून ₹{amount} मिळाले' },
    bodyNoAmount: { en: 'Payment received from {who}', hi: '{who} से भुगतान प्राप्त हुआ', mr: '{who} कडून पेमेंट मिळाले' }
  },
  human_needed: {
    title: { en: 'Customer needs your reply', hi: 'ग्राहक को आपके जवाब की ज़रूरत है', mr: 'ग्राहकाला तुमच्या उत्तराची गरज आहे' },
    body: {
      en: "{who} asked something the bot couldn't answer",
      hi: '{who} ने ऐसा कुछ पूछा जिसका जवाब बॉट नहीं दे सका',
      mr: '{who} ने असे काहीतरी विचारले ज्याचे उत्तर बॉट देऊ शकला नाही'
    },
    // The "still waiting" reminder of an open handoff (handoff.service.js#runReminder).
    bodyReminder: {
      en: '{who} is still waiting for your reply',
      hi: '{who} अभी भी आपके जवाब का इंतज़ार कर रहा है',
      mr: '{who} अजूनही तुमच्या उत्तराची वाट पाहत आहे'
    }
  },
  booking_cancelled: {
    title: { en: 'Booking cancelled', hi: 'बुकिंग रद्द हुई', mr: 'बुकिंग रद्द झाली' },
    body: { en: '{who} cancelled their booking', hi: '{who} ने अपनी बुकिंग रद्द की', mr: '{who} ने त्यांची बुकिंग रद्द केली' }
  },
  new_message: {
    title: { en: 'New message', hi: 'नया संदेश', mr: 'नवीन संदेश' },
    body: { en: 'Message from {who}', hi: '{who} का संदेश', mr: '{who} चा संदेश' }
  },
  customer_waiting: {
    title: { en: 'Customer is waiting', hi: 'ग्राहक इंतज़ार कर रहा है', mr: 'ग्राहक वाट पाहत आहे' },
    body: {
      en: '{who} has had no reply for 10 minutes',
      hi: '{who} को 10 मिनट से जवाब नहीं मिला',
      mr: '{who} ला 10 मिनिटांपासून उत्तर मिळालेले नाही'
    }
  },
  whatsapp_disconnected: {
    title: { en: 'WhatsApp disconnected', hi: 'WhatsApp डिस्कनेक्ट हो गया', mr: 'WhatsApp डिस्कनेक्ट झाले' },
    body: {
      en: 'Your bot cannot reply until you reconnect WhatsApp',
      hi: 'WhatsApp दोबारा जोड़ने तक आपका बॉट जवाब नहीं दे सकता',
      mr: 'WhatsApp पुन्हा जोडेपर्यंत तुमचा बॉट उत्तर देऊ शकत नाही'
    }
  },
  payment_issue: {
    title: { en: 'WhatsApp payment problem', hi: 'WhatsApp पेमेंट में समस्या', mr: 'WhatsApp पेमेंटमध्ये समस्या' },
    body: {
      en: 'Meta could not charge your payment method. Fix it to keep sending messages',
      hi: 'Meta आपके पेमेंट तरीके से भुगतान नहीं ले सका। संदेश भेजते रहने के लिए इसे ठीक करें',
      mr: 'Meta तुमच्या पेमेंट पद्धतीतून पैसे घेऊ शकले नाही. संदेश पाठवत राहण्यासाठी ती दुरुस्त करा'
    }
  },
  usage_90: {
    title: { en: 'Message limit almost reached', hi: 'मैसेज लिमिट लगभग पूरी', mr: 'मेसेज मर्यादा जवळजवळ संपली' },
    body: {
      en: "You have used 90% of this month's messages",
      hi: 'आपने इस महीने के 90% मैसेज इस्तेमाल कर लिए हैं',
      mr: 'तुम्ही या महिन्याचे 90% मेसेज वापरले आहेत'
    }
  },
  usage_100: {
    title: { en: 'Message limit reached', hi: 'मैसेज लिमिट पूरी हो गई', mr: 'मेसेज मर्यादा संपली' },
    body: {
      en: 'Your bot has stopped replying. Upgrade your plan to continue',
      hi: 'आपके बॉट ने जवाब देना बंद कर दिया है। जारी रखने के लिए प्लान अपग्रेड करें',
      mr: 'तुमच्या बॉटने उत्तर देणे थांबवले आहे. सुरू ठेवण्यासाठी प्लॅन अपग्रेड करा'
    }
  },
  plan_expiring: {
    title: { en: 'Plan expiring soon', hi: 'प्लान जल्द समाप्त होगा', mr: 'प्लॅन लवकरच संपेल' },
    body: {
      en: 'Your plan ends in {days} days. Renew to keep your bot running',
      hi: 'आपका प्लान {days} दिन में समाप्त हो रहा है। बॉट चालू रखने के लिए रिन्यू करें',
      mr: 'तुमचा प्लॅन {days} दिवसांत संपत आहे. बॉट सुरू ठेवण्यासाठी रिन्यू करा'
    }
  },
  plan_expired: {
    title: { en: 'Plan expired', hi: 'प्लान समाप्त हो गया', mr: 'प्लॅन संपला' },
    body: {
      en: 'Your bot has stopped replying. Renew your plan to restart it',
      hi: 'आपके बॉट ने जवाब देना बंद कर दिया है। फिर से चालू करने के लिए प्लान रिन्यू करें',
      mr: 'तुमच्या बॉटने उत्तर देणे थांबवले आहे. पुन्हा सुरू करण्यासाठी प्लॅन रिन्यू करा'
    }
  },
  quality_dropped: {
    title: { en: 'WhatsApp quality rating dropped', hi: 'WhatsApp क्वालिटी रेटिंग गिर गई', mr: 'WhatsApp क्वालिटी रेटिंग घसरले' },
    body: {
      en: 'Customers may be blocking or reporting your messages. Review what you send',
      hi: 'ग्राहक आपके संदेश ब्लॉक या रिपोर्ट कर सकते हैं। जो भेजते हैं उसकी समीक्षा करें',
      mr: 'ग्राहक तुमचे संदेश ब्लॉक किंवा रिपोर्ट करत असतील. तुम्ही काय पाठवता ते तपासा'
    }
  }
};

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined || vars[key] === null ? '' : String(vars[key])));

const normalizeLanguage = (language) => (LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE);

/** @returns {{title: string, body: string}} wording for a type in a language */
const buildText = (type, payload, language) => {
  const lang = normalizeLanguage(language);
  const text = TEXT[type];
  const who = payload.customerName || payload.customerNumber || WHO_FALLBACK[lang];
  const vars = { who, amount: payload.amount, days: payload.days };
  const title = text.title[lang];

  if (type === 'booking_new') {
    // customer · vehicle/service · date, whichever of them are known.
    const parts = [payload.customerName || payload.customerNumber, payload.summary, payload.date].filter(Boolean);
    return { title, body: parts.length > 0 ? parts.join(' · ') : text.body[lang] };
  }
  if (type === 'payment_received' && !payload.amount) return { title, body: fill(text.bodyNoAmount[lang], vars) };
  if (type === 'human_needed' && payload.reminder) return { title, body: fill(text.bodyReminder[lang], vars) };
  const body = fill(text.body[lang], vars);
  if (type === 'new_message' && payload.preview) return { title, body: `${who}: ${payload.preview}` };
  return { title, body };
};

const routeFor = (type, payload) => {
  const def = TYPES[type];
  if (def.route) return def.route;
  if (type === 'booking_new' || type === 'booking_cancelled') return payload.bookingId ? `/bookings/${payload.bookingId}` : '/bookings';
  if (type === 'payment_received') return payload.bookingId ? `/bookings/${payload.bookingId}` : '/payments';
  return payload.customerId ? `/messages/${payload.customerId}` : '/messages';
};

// ── Preferences ──────────────────────────────────────────────────────────────
// Shape (GET/PUT /api/notifications/preferences), exactly:
//   { types: { <PREF_TYPES>: bool }, voiceEnabled: bool,
//     quietHours: { enabled: bool, start: 'HH:mm', end: 'HH:mm' } }
// Critical types are not user-switchable, so they are not in `types`.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREF_TYPES = TYPE_NAMES.filter((name) => TYPES[name].kind !== 'critical');
const DEFAULT_QUIET = { enabled: false, start: '22:00', end: '07:00' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stored prefs (possibly '{}') -> the full shape with defaults merged in. */
const resolvePrefs = (stored) => {
  const prefs = isPlainObject(stored) ? stored : {};
  const quiet = isPlainObject(prefs.quietHours) ? prefs.quietHours : {};
  const types = {};
  for (const name of PREF_TYPES) types[name] = !(isPlainObject(prefs.types) && prefs.types[name] === false);
  return {
    types,
    voiceEnabled: prefs.voiceEnabled !== false,
    quietHours: {
      enabled: quiet.enabled === true,
      start: HHMM.test(quiet.start || '') ? quiet.start : DEFAULT_QUIET.start,
      end: HHMM.test(quiet.end || '') ? quiet.end : DEFAULT_QUIET.end
    }
  };
};

/**
 * Validates a PUT body. Unknown keys / types and wrong value types are errors, and the
 * error names the field. Missing keys are fine (they take their defaults).
 * @returns {{ok: true, prefs: object}|{ok: false, field: string, error: string}}
 */
const validatePrefs = (body) => {
  const bad = (field, error) => ({ ok: false, field, error: `${field}: ${error}` });
  if (!isPlainObject(body)) return bad('body', 'must be an object');
  for (const key of Object.keys(body)) {
    if (!['types', 'voiceEnabled', 'quietHours'].includes(key)) return bad(key, 'unknown setting');
  }
  const prefs = {};
  if (body.types !== undefined) {
    if (!isPlainObject(body.types)) return bad('types', 'must be an object');
    prefs.types = {};
    for (const [name, value] of Object.entries(body.types)) {
      if (!PREF_TYPES.includes(name)) return bad(`types.${name}`, 'unknown notification type');
      if (typeof value !== 'boolean') return bad(`types.${name}`, 'must be true or false');
      prefs.types[name] = value;
    }
  }
  if (body.voiceEnabled !== undefined) {
    if (typeof body.voiceEnabled !== 'boolean') return bad('voiceEnabled', 'must be true or false');
    prefs.voiceEnabled = body.voiceEnabled;
  }
  if (body.quietHours !== undefined) {
    const q = body.quietHours;
    if (!isPlainObject(q)) return bad('quietHours', 'must be an object');
    prefs.quietHours = {};
    for (const key of Object.keys(q)) {
      if (!['enabled', 'start', 'end'].includes(key)) return bad(`quietHours.${key}`, 'unknown setting');
    }
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== 'boolean') return bad('quietHours.enabled', 'must be true or false');
      prefs.quietHours.enabled = q.enabled;
    }
    for (const key of ['start', 'end']) {
      if (q[key] === undefined) continue;
      if (typeof q[key] !== 'string' || !HHMM.test(q[key])) return bad(`quietHours.${key}`, 'must be HH:mm (24-hour)');
      prefs.quietHours[key] = q[key];
    }
  }
  return { ok: true, prefs };
};

/** True when `now` (India time) is inside the user's quiet hours. Only when enabled; start == end is off; handles a window past midnight. */
const isQuietHours = (resolvedPrefs, now = new Date()) => {
  const { enabled, start: quietStart, end: quietEnd } = resolvedPrefs.quietHours;
  if (!enabled || quietStart === quietEnd) return false;
  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  const current = istMinuteOfDay(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
};

/**
 * The Android channel for one device. Critical ignores toggles and quiet hours.
 * Voice types: quiet hours -> silent, voice off -> normal messages channel.
 */
const pickChannel = ({ type, language, voice = true, quiet = false }) => {
  const kind = TYPES[type].kind;
  const voiceChannel = `v1_${type}_${normalizeLanguage(language)}`;
  if (kind === 'critical') return TYPES[type].voice ? voiceChannel : CHANNEL_CRITICAL;
  if (kind === 'normal') return CHANNEL_NORMAL;
  if (quiet) return CHANNEL_SILENT;
  if (!voice) return CHANNEL_NORMAL;
  return voiceChannel;
};

// ── Recipients ───────────────────────────────────────────────────────────────
/**
 * Active owner + (for non-critical types) active staff whose permission covers the type.
 * @returns {Promise<string[]>} user ids
 */
const getRecipientIds = async (businessId, type) => {
  const def = TYPES[type];
  const { data, error } = await supabase
    .from('users')
    .select('id, role, is_active, can_view_chats, can_manage_bookings, can_manage_billing')
    .eq('business_id', businessId);
  if (error) throw error;
  return (data || []).filter((u) => {
    if (u.is_active === false) return false;
    if (u.role === 'owner') return true;
    if (u.role !== 'staff' || def.kind === 'critical') return false;
    return u[PERMISSION_COLUMNS[def.permission]] === true;
  }).map((u) => u.id);
};

/**
 * Sends a push for a business event. Fire-and-forget: callers don't await it,
 * and it never throws or rejects.
 * @param {string} businessId
 * @param {string} type one of TYPE_NAMES
 * @param {object} [payload] customerId, customerName, customerNumber, bookingId,
 *   summary (vehicle/service), date, amount, days, preview
 * @param {{onlyUserId?: string, excludeUserId?: string, test?: boolean}} [opts] excludeUserId
 *   is left out of the recipients (the person who caused the event); test sends skip the
 *   permission filter, per-type toggle and quiet hours, and go only to onlyUserId
 */
const notify = async (businessId, type, payload = {}, opts = {}) => {
  try {
    const def = TYPES[type];
    if (!def) {
      logger.warn(`Push: unknown notification type "${type}"`);
      return;
    }
    if (!businessId || !pushService.isPushEnabled()) return;

    const userIds = (opts.onlyUserId ? [opts.onlyUserId] : await getRecipientIds(businessId, type))
      .filter((id) => id !== opts.excludeUserId);
    if (userIds.length === 0) return;

    const { data: devices, error: devErr } = await supabase
      .from('device_tokens').select('user_id, token, language').eq('business_id', businessId).in('user_id', userIds);
    if (devErr) throw devErr;
    if (!devices || devices.length === 0) return;

    const { data: prefRows, error: prefErr } = await supabase
      .from('notification_preferences').select('user_id, prefs').eq('business_id', businessId).in('user_id', userIds);
    if (prefErr) throw prefErr;
    const prefsByUser = new Map((prefRows || []).map((row) => [row.user_id, resolvePrefs(row.prefs)]));

    const now = new Date();
    const route = routeFor(type, payload);
    const tag = `${type}:${payload.customerId || payload.bookingId || (opts.test ? now.getTime() : 'event')}`;
    const data = { type, route };
    for (const key of ['customerId', 'bookingId']) {
      if (payload[key]) data[key] = String(payload[key]);
    }

    // One FCM call per (language, channel): the wording and the channel differ by device.
    const groups = new Map();
    for (const device of devices) {
      const prefs = prefsByUser.get(device.user_id) || resolvePrefs(null);
      const isCritical = def.kind === 'critical';
      if (!isCritical && !opts.test && prefs.types[type] === false) continue;
      const language = normalizeLanguage(device.language);
      const quiet = !isCritical && !opts.test && isQuietHours(prefs, now);
      const channelId = pickChannel({ type, language, voice: prefs.voiceEnabled, quiet });
      const key = `${language}|${channelId}`;
      if (!groups.has(key)) groups.set(key, { language, channelId, tokens: [] });
      groups.get(key).tokens.push(device.token);
    }

    for (const { language, channelId, tokens } of groups.values()) {
      const { title, body } = buildText(type, payload, language);
      await pushService.sendToDevices(tokens, {
        notification: { title, body },
        android: { priority: 'high', notification: { channelId, tag } },
        data
      });
    }
  } catch (err) {
    logger.error(`Push: notify ${type} for business ${businessId} failed:`, err);
  }
};

// ── Reading the customer's message (human_needed) ────────────────────────────
const ACK_PHRASES = new Set([
  'ok', 'okay', 'thanks', 'thank you', 'thx', 'ok sir',
  'ho', 'हो', 'हाँ', 'ठीक', 'ठीक है', 'ठीक आहे', 'धन्यवाद', 'बरं'
]);
const ACK_EMOJI = /^[\s👍🙏]+$/u;
const HUMAN_REQUESTS = [
  'talk to owner', 'call me', 'human', 'real person', 'speak to',
  'मालक', 'बोलायचे', 'बात करनी', 'कॉल करो', 'फोन करा', 'call kar'
];

/** A short thank-you / OK ("ok", "thanks", "👍", "ठीक है" ...): 3 words or fewer and on the list. Needs no human. */
const isAcknowledgement = (text) => {
  const t = String(text || '').trim().toLowerCase().replace(/[.,!?।]+$/u, '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (ACK_EMOJI.test(t)) return true;
  return t.split(' ').length <= 3 && ACK_PHRASES.has(t);
};

/** The customer explicitly asks for a person: a case-insensitive "contains" on a fixed list of en / hi / mr phrases. */
const asksForHuman = (text) => {
  const t = String(text || '').toLowerCase();
  return HUMAN_REQUESTS.some((phrase) => t.includes(phrase));
};

// ── Redis helpers: dedupe and throttle ───────────────────────────────────────
/** SET NX EX. True only for the first caller within the TTL; false on a repeat or a Redis failure. */
const claimOnce = async (key, ttlSeconds) => {
  try {
    // Lazy: importing this module (many services do) must not open a Redis connection.
    const redis = require('../config/redis');
    return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  } catch (err) {
    logger.error(`Push: Redis dedupe failed for ${key}:`, err);
    return false;
  }
};

/**
 * notify() at most once per `dedupeKey` within `ttlSeconds` - for critical events
 * that are detected repeatedly (a failed send, every inbound message, a daily cron).
 */
const notifyOnce = async (businessId, type, payload, dedupeKey, ttlSeconds) => {
  try {
    if (!pushService.isPushEnabled()) return;
    if (!(await claimOnce(`notif:once:${type}:${dedupeKey}`, ttlSeconds))) return;
    await module.exports.notify(businessId, type, payload);
  } catch (err) {
    logger.error(`Push: notifyOnce ${type} for business ${businessId} failed:`, err);
  }
};

/**
 * An inbound message while the bot is paused for that customer: notify at most
 * once per customer per 2 minutes, and plan a customer_waiting check 10 minutes on
 * (not while a handoff is open for that customer: skipWaitingCheck - it has its own reminder).
 */
const notifyNewMessage = async (businessId, payload, { skipWaitingCheck = false } = {}) => {
  try {
    if (!pushService.isPushEnabled() || !payload.customerId) return;
    if (!(await claimOnce(`notif:newmsg:${businessId}:${payload.customerId}`, NEW_MESSAGE_THROTTLE_SECONDS))) return;
    await module.exports.notify(businessId, 'new_message', payload);
    if (skipWaitingCheck) return;
    // Lazy: keeps the BullMQ queue (and its Redis use) out of anything that only imports this module.
    const { scheduleCustomerWaiting } = require('../queues/customerWaiting.queue');
    await scheduleCustomerWaiting({
      businessId,
      customerId: payload.customerId,
      customerName: payload.customerName || null,
      customerNumber: payload.customerNumber || null,
      since: new Date().toISOString()
    }, CUSTOMER_WAITING_DELAY_MS);
  } catch (err) {
    logger.error(`Push: notifyNewMessage for business ${businessId} failed:`, err);
  }
};

/**
 * Runs when the customer_waiting job fires: if nobody (bot, dashboard or the
 * phone app) has sent that customer anything since the message, notify.
 * @returns {Promise<'notified'|'answered'|'error'>}
 */
const runCustomerWaitingCheck = async ({ businessId, customerId, customerName, customerNumber, since }) => {
  try {
    const { data, error } = await supabase
      .from('messages').select('id')
      .eq('business_id', businessId).eq('customer_id', customerId).eq('direction', 'outbound')
      .gt('created_at', since).limit(1);
    if (error) throw error;
    if (data && data.length > 0) return 'answered';
    await module.exports.notify(businessId, 'customer_waiting', { customerId, customerName, customerNumber });
    return 'notified';
  } catch (err) {
    logger.error(`Push: customer_waiting check for customer ${customerId} failed:`, err);
    return 'error';
  }
};

/** A sample push of `type` to one user's own devices (POST /api/notifications/test). */
const sendTest = (businessId, userId, type) => notify(businessId, type, {
  customerName: 'Test Customer',
  customerNumber: '919999999999',
  summary: 'Test',
  date: new Date().toISOString().slice(0, 10),
  amount: 500,
  days: 3,
  preview: 'This is a test notification'
}, { onlyUserId: userId, test: true });

module.exports = {
  TYPE_NAMES,
  TYPES,
  notify,
  notifyOnce,
  notifyNewMessage,
  runCustomerWaitingCheck,
  sendTest,
  resolvePrefs,
  validatePrefs,
  isQuietHours,
  pickChannel,
  buildText,
  isAcknowledgement,
  asksForHuman,
  normalizeLanguage
};
