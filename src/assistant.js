'use strict';
// "Ask MamaSafe": a safe, rule-based helper. It does NOT make up answers. Every reply is either
//  - an emergency / urgent warning (checked FIRST, so a danger sign is never answered as small talk),
//  - a fixed, reviewed answer to a common question, or
//  - "I am not sure": the mother can send her question to her clinic.
// All wording below must be reviewed by a midwife or doctor before real mothers rely on it.
const schedule = require('./schedule');
const config = require('./config');

const SOS = ['sos', 'call'];

// ---- danger signs: ALWAYS checked first. Better to over-warn than miss one. ----
const CRISIS = /(kill|hurt|harm|end)\s+(myself|my life)|want to die|suicid|no reason to live|better off dead/;
const EMERGENCY = [
  /bleed|blood(?!\s*(pressure|test|group|sugar|donat))|haemorrhag|hemorrhag/,
  /\bfits?\b|convuls|seiz|unconscious|collaps|pass(ed)? out|faint/,
  /(severe|terrible|worst|bad|strong|heavy).{0,15}headache|headache.{0,25}(blur|vision|sight)|blur.{0,15}(vision|eye|sight)|flashing|cannot see|can'?t see/,
  /(baby|movement|moves?|kicks?).{0,40}(stopp|not mov|less|reduc|no mov|not kick|not feel|gone quiet)|(stopp|not|no|less|cannot|can'?t).{0,20}(feel|mov|kick).{0,20}(baby|move|kick)/,
  /(water|waters|fluid).{0,15}(broke|break|leak|gush)|\bleaking\b/,
  /(severe|sharp|terrible|unbearable|strong|constant).{0,20}(pain|belly|stomach|abdom)/,
  /(can'?t|cannot|difficult|hard|short|struggl).{0,15}breath|breathless/
];
// Needs a clinic visit soon (same day), not necessarily an ambulance.
const URGENT = [
  /swoll?en.{0,15}(face|hands?|eyes?)|(face|hands?).{0,12}swoll?en|puffy/,
  /(cannot|can'?t|unable|not able|won'?t).{0,10}(keep|hold).{0,10}(food|water|anything|down)|vomit.{0,20}(all day|everything|cannot|nothing)/,
  /fever|hot body|high temperature|chills|shiver/,
  /burning.{0,20}(urin|pee|passing)|pain.{0,15}(urin|pee)|spotting/,
  /itch.{0,15}(all over|whole body|hands|feet)/
];
const LABOUR = /labou?r|contraction|pushing|baby is coming|delivery pains|birth pains/;

// ---- FAQ ----
const faq = [
  { id: 'visits', q: 'How many antenatal visits do I need?', k: ['visit', 'antenatal', 'anc', 'appointment', 'check up', 'checkup', 'how often', 'schedule'],
    a: () => `You need at least 8 antenatal visits. Most are around weeks ${schedule.CONTACT_WEEKS.join(', ')}. Your own dates are under Visits. Go sooner if you are worried about anything.`, acts: ['visits'] },
  { id: 'bring', q: 'What should I bring to the clinic or hospital?', k: ['bring', 'pack', 'carry', 'bag', 'take with', 'need to take', 'what to take'],
    a: () => 'Bring your antenatal card and any test results, your ID if you have one, some money for transport, your phone and charger, and the number of your emergency contact. For delivery, also pack clean kangas or lesus, pads, soap, and a blanket and clothes for baby. There is a checklist you can tick off.', acts: ['bag'] },
  { id: 'nausea', q: 'Is nausea and vomiting normal?', k: ['nause', 'morning sick', 'vomit', 'throw up', 'throwing up', 'sick in the morning'],
    a: () => 'Nausea is common in the first months and usually eases by about week 16 to 20. Eat small amounts often, sip water, and avoid very oily or strong-smelling food. If you cannot keep any food or water down, feel weak or dizzy, or have pain, go to the health facility the same day.', acts: ['check'] },
  { id: 'heartburn', q: 'What can I do about heartburn?', k: ['heartburn', 'acid', 'burning chest', 'burning in my chest', 'indigestion'],
    a: () => 'Heartburn is common later in pregnancy. Eat smaller meals, avoid lying down straight after eating, and sleep with your head and shoulders raised on a pillow. If it is severe, or comes with a bad headache or pain under the ribs, go to the clinic.', acts: ['check'] },
  { id: 'backache', q: 'I have backache. Is it normal?', k: ['backache', 'back pain', 'my back', 'lower back'],
    a: () => 'Mild backache is common as the baby grows. Rest, sit with support, avoid heavy lifting, and wear flat shoes. If the pain is severe, comes in waves, or comes with bleeding or fluid, go to the facility now.', acts: ['check'] },
  { id: 'cramps', q: 'I get leg cramps at night', k: ['cramp', 'leg pain', 'calf'],
    a: () => 'Leg cramps are common. Stretch your calf, walk a little, and keep up a normal diet with fruit and vegetables. If one leg is swollen, red, hot or very painful, go to the clinic.', acts: ['check'] },
  { id: 'swelling', q: 'My feet are swollen', k: ['swell', 'swollen', 'swelling', 'feet', 'ankle', 'legs are big'],
    a: () => 'Mild swelling of the feet in the evening is common. Rest with your feet up. Swelling of the face or hands, or swelling with a headache or blurred vision, is a danger sign: go to the facility now.', acts: ['check'] },
  { id: 'iron', q: 'Should I take iron and folic acid tablets?', k: ['iron', 'folic', 'tablet', 'pill', 'vitamin', 'supplement', 'blood tablets', 'anaemia', 'anemia'],
    a: () => 'Yes, take the iron and folic acid tablets your health worker gives you, every day as advised. They protect you and your baby from anaemia. Take them with water or juice rather than tea, which stops iron being absorbed. Dark stools are normal with iron. Tell your health worker if they upset your stomach; do not just stop.' },
  { id: 'malaria', q: 'How do I protect myself from malaria?', k: ['malaria', 'mosquito', 'net', 'anti malarial', 'antimalarial'],
    a: () => 'Malaria is more dangerous in pregnancy. Sleep under a treated mosquito net every night. At your visits the health worker can give malaria prevention medicine. If you have a fever, go for a malaria test the same day.', acts: ['check'] },
  { id: 'hiv', q: 'Why am I offered an HIV test?', k: ['hiv', 'aids', 'syphilis', 'blood test', 'tests', 'test for'],
    a: () => 'At your first visit you are offered tests such as HIV and syphilis. Knowing early lets you get treatment that keeps you healthy and protects your baby. Your results are private between you and your health worker.' },
  { id: 'tetanus', q: 'Do I need a tetanus injection?', k: ['tetanus', 'vaccine', 'vaccination', 'injection', 'immuni', 'tt '],
    a: () => 'Tetanus vaccine in pregnancy protects you and your newborn. Your health worker will check your card and tell you which dose you need. Bring your antenatal card and any old vaccination card.' },
  { id: 'food', q: 'What should I eat?', k: ['eat', 'food', 'diet', 'nutrition', 'hungry', 'fruit', 'meal', 'drink water'],
    a: () => 'Eat a mix of foods: staples such as matooke, posho, rice or potatoes; beans, groundnuts, eggs, fish or meat; green leafy vegetables; and fruit. Add one extra small meal each day. Drink clean, boiled or treated water. Avoid raw or undercooked meat and unboiled milk.' },
  { id: 'avoid', q: 'What should I avoid? (alcohol, smoking, herbs, medicines)', k: ['alcohol', 'beer', 'waragi', 'smoke', 'smoking', 'tobacco', 'herb', 'traditional medicine', 'medicine', 'paracetamol', 'drug', 'painkiller'],
    a: () => 'Avoid alcohol and smoking completely. Do not take herbal or traditional medicines, or any tablets you buy, unless your health worker says they are safe in pregnancy. Ask first, even for common painkillers.' },
  { id: 'activity', q: 'Can I work and exercise?', k: ['exercise', 'walk', 'work', 'lift', 'digging', 'farm', 'garden', 'carry water', 'heavy'],
    a: () => 'Light activity such as walking is good for you. Rest when you are tired and avoid heavy lifting and long hours of hard digging or carrying. Stop and rest if you feel dizzy, have pain, or bleeding. Ask your health worker if you are unsure.' },
  { id: 'movement', q: 'When will I feel the baby move?', k: ['move', 'movement', 'kick', 'flutter', 'feel the baby', 'feel my baby', 'first time'],
    a: () => 'Most mothers feel the first flutters between about weeks 16 and 24, often later with a first baby. Get to know your baby\'s usual pattern. If your baby moves less than usual, do not wait: go to the health facility the same day.', acts: ['check'] },
  { id: 'danger', q: 'What are the danger signs?', k: ['danger', 'warning sign', 'when should i worry', 'when to worry', 'emergency sign', 'what is serious', 'serious'],
    a: () => 'Go to a health facility straight away, and press SOS, if you have: heavy bleeding, fits, a severe headache with blurred vision, baby moving much less or not at all, fluid leaking from the vagina, severe belly pain, high fever with chills, or difficulty breathing.', acts: SOS },
  { id: 'sos', q: 'How does the SOS button work?', k: ['sos', 'alert', 'emergency button', 'how does the emergency', 'press sos'],
    a: () => 'Press SOS, then Send emergency alert. MamaSafe tells your health facility, asks nearby drivers to come for you, and texts your emergency contact. It is always free. If you cannot use the app, call ' + config.emergencyNumber + '.', acts: ['sos'] },
  { id: 'contact', q: 'What is the emergency contact for?', k: ['emergency contact', 'contact person', 'husband', 'partner', 'someone to call', 'who gets the message'],
    a: () => 'Your emergency contact is someone you trust, such as your husband, sister or neighbour. They are texted if you press SOS. Add their number on the Home screen and ask them for the code we send them, so we know the number is right.', acts: ['home'] },
  { id: 'phone', q: 'I do not have a smartphone', k: ['smartphone', 'ussd', 'basic phone', 'no data', 'keypad', 'feature phone', '*123'],
    a: () => `You can use MamaSafe on any phone. Dial ${config.ussdCode || 'the USSD code'}${config.smsNumber ? ` or text HELP to ${config.smsNumber}` : ''}. You can register, see your visit dates and send an emergency alert without data.` },
  { id: 'cost', q: 'Is it free?', k: ['free', 'cost', 'pay', 'fee', 'price', 'charge', 'money'],
    a: () => 'Emergency alerts, the symptom check and the hospital finder are always free. Ask at your clinic about anything else.' },
  { id: 'privacy', q: 'Who can see my information?', k: ['privacy', 'private', 'secret', 'who can see', 'my data', 'my information', 'confidential'],
    a: () => 'Your number and details are only used to send you reminders and to alert your clinic and emergency contact when you ask for help. We do not sell or share them.' },
  { id: 'breast', q: 'When should I start breastfeeding?', k: ['breastfeed', 'breast feed', 'breast milk', 'breast', 'feed the baby', 'colostrum'],
    a: () => 'Start breastfeeding within the first hour after birth. The first thick yellow milk (colostrum) protects your baby. Give only breast milk, with no water or other food, for the first 6 months.' },
  { id: 'sleep', q: 'I feel tired and cannot sleep well', k: ['tired', 'fatigue', 'sleep', 'insomnia', 'exhausted'],
    a: () => 'Tiredness is common, especially in the first and last months. Rest when you can and eat regularly. Sleeping on your side with a pillow between your knees is comfortable. If you feel very weak, pale or breathless, tell your health worker: you may need a blood check.', acts: ['check'] },
  { id: 'mood', q: 'I feel worried or sad', k: ['worried', 'sad', 'anxious', 'anxiety', 'stress', 'depress', 'lonely', 'afraid', 'scared', 'fear', 'cry'],
    a: () => 'Feeling worried or sad during pregnancy is common, and you are not alone. Talk to someone you trust and tell your midwife at your next visit, because there is help. If you ever feel you might harm yourself, go to a health facility or call ' + config.emergencyNumber + ' now.' },
  { id: 'labour', q: 'When do I go to the hospital to deliver?', k: ['deliver', 'delivery', 'birth', 'give birth', 'when do i go', 'due date is near'],
    a: () => 'Go to the facility if you have regular, painful tightenings that come closer together, if your waters break, if you bleed, or if baby moves less. Do not wait at home if you live far: leave early and plan your transport. SOS can ask nearby drivers to come for you.', acts: ['sos', 'bag'] }
];
const MATCH_MIN = 1;

const norm = (t) => ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9*'\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

function score(entry, text) {
  let s = 0;
  for (const k of entry.k) if (text.includes(k.includes(' ') || k.length <= 3 ? ' ' + k.trim() + ' ' : ' ' + k)) s += k.includes(' ') ? 2 : 1;
  return s;
}

function intents(text, mother) {
  const g = schedule.gestation(mother.lmp);
  if (/\b(what|which) week\b|how many weeks|how far along|how pregnant|my gestation/.test(text))
    return { text: `You are in week ${g.weeks}, day ${g.days + 1} of your pregnancy. Your baby is due about ${schedule.pretty(schedule.edd(mother.lmp))}.`, acts: [] };
  if (/due date|\bedd\b|when (is|will) (the|my) baby|when (am i|will i) (due|deliver)/.test(text))
    return { text: `Your due date is about ${schedule.pretty(schedule.edd(mother.lmp))}. Babies often come a little earlier or later, so be ready from week 37.`, acts: ['bag'] };
  if (/next (visit|appointment|checkup|check up|clinic)|my (visit|appointment)s? (date|day)|when (is|do i go).{0,12}(visit|appointment|clinic)/.test(text)) {
    const n = schedule.nextVisit(mother.lmp);
    return { text: n ? `Your next visit is visit ${n.no} of 8, on ${schedule.pretty(n.date)}.` : 'You have no more visits planned. If you are worried, go to your clinic.', acts: ['visits'] };
  }
  return null;
}

// Returns { kind, title?, text, acts[] }. kind: emergency | crisis | urgent | answer | unknown
function answer(raw, mother) {
  const text = norm(raw);
  if (text.trim().length < 2) return { kind: 'unknown', text: 'Type your question and I will try to help.', acts: [] };

  if (CRISIS.test(text)) return { kind: 'crisis', text: `I am sorry you feel this way, and I am glad you said it. You do not have to carry this alone. Please go to a health facility now or call ${config.emergencyNumber}, and tell someone you trust to stay with you. If you are in danger right now, press SOS.`, acts: SOS };
  if (EMERGENCY.some((re) => re.test(text))) return { kind: 'emergency', text: 'This can be a danger sign. Go to a health facility now. Do not wait. Press SOS so your clinic and a driver are alerted, or call for help.', acts: SOS };
  if (LABOUR.test(text)) {
    const w = mother ? schedule.gestation(mother.lmp).weeks : 40;
    return w < 37
      ? { kind: 'emergency', text: `Labour signs before week 37 need care straight away. Go to a health facility now and press SOS. You are in week ${w}.`, acts: SOS }
      : { kind: 'urgent', text: 'If you have regular painful tightenings that are coming closer, or your waters have broken, go to the health facility now. If you live far, leave early. SOS can ask nearby drivers to come for you.', acts: ['sos', 'call'] };
  }
  if (URGENT.some((re) => re.test(text))) return { kind: 'urgent', text: 'This needs a check by a health worker today. Go to your clinic, or call them first. If it gets worse, or you also have bleeding, a bad headache, or baby moving less, press SOS.', acts: ['call', 'check', 'sos'] };

  const it = mother ? intents(text, mother) : null;
  if (it) return { kind: 'answer', title: null, text: it.text, acts: it.acts };

  if (/^\s*(hi|hello|hey|hallo|good (morning|afternoon|evening)|webale|thanks|thank you|asante)\b/.test(text.trim()))
    return { kind: 'answer', title: null, text: 'Hello. You can ask me about visits, food, tablets, common discomforts or what to do in an emergency. I am an automated helper, not a doctor.', acts: [] };

  let best = null, top = 0;
  for (const e of faq) { const s = score(e, text); if (s > top) { top = s; best = e; } }
  if (best && top >= MATCH_MIN) return { kind: 'answer', title: best.q, text: best.a(), acts: best.acts || [] };
  return { kind: 'unknown', text: 'I am not sure about that one. I do not want to guess about your health. You can send your question to your clinic, or call them.', acts: ['escalate', 'call'] };
}

const SUGGESTIONS = ['When is my next visit?', 'What should I bring to the clinic?', 'Is nausea normal?', 'Do I need iron tablets?', 'What are the danger signs?', 'How do I protect myself from malaria?'];

module.exports = { answer, SUGGESTIONS, faq };
