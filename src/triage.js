'use strict';
// Danger-sign triage. CLINICAL CONTENT: this list follows commonly published antenatal danger
// signs, but it MUST be reviewed and signed off by a qualified clinician / the national
// maternal health programme before real mothers rely on it.

const SYMPTOMS = [
  { id: 'bleeding', level: 'emergency', label: 'Heavy vaginal bleeding', ussd: 'Heavy bleeding' },
  { id: 'fits', level: 'emergency', label: 'Fits or convulsions', ussd: 'Fits' },
  { id: 'headache', level: 'emergency', label: 'Severe headache with blurred vision', ussd: 'Bad headache, blurred sight' },
  { id: 'movement', level: 'emergency', label: 'Baby moving much less or not at all', ussd: 'Baby not moving' },
  { id: 'belly', level: 'emergency', label: 'Severe belly pain', ussd: 'Severe belly pain' },
  { id: 'fluid', level: 'emergency', label: 'Fluid leaking from the vagina', ussd: 'Water leaking' },
  { id: 'fever', level: 'emergency', label: 'High fever with chills', ussd: 'High fever' },
  { id: 'breath', level: 'emergency', label: 'Difficulty breathing', ussd: 'Hard to breathe' },
  { id: 'swelling', level: 'urgent', label: 'Swollen face or hands', ussd: 'Swollen face/hands' },
  { id: 'vomiting', level: 'urgent', label: 'Vomiting, cannot keep food down', ussd: 'Vomiting a lot' },
  { id: 'urine', level: 'urgent', label: 'Burning when passing urine', ussd: 'Painful urine' },
  { id: 'mild', level: 'mild', label: 'Backache, tiredness, heartburn or leg cramps', ussd: 'Backache, tired' },
  // Not a symptom: the mother pressed SOS / sent the SOS keyword.
  { id: 'sos', level: 'emergency', label: 'Emergency alert (SOS)', ussd: 'SOS', hidden: true }
];

const BY_ID = Object.fromEntries(SYMPTOMS.map((s) => [s.id, s]));
const RANK = { none: 0, mild: 1, urgent: 2, emergency: 3 };

const ADVICE = {
  none: 'If something feels wrong, even if it is not listed, go to a health facility.',
  mild: 'These are common in pregnancy. Tell the midwife at your next visit. Check again if you get worse.',
  urgent: 'Get checked by a midwife or doctor today. Do not wait for your next visit.',
  emergency: 'Go to a health facility now. Do not wait. Call for emergency help if you cannot get there.'
};

function visibleSymptoms() {
  return SYMPTOMS.filter((s) => !s.hidden).map(({ id, level, label, ussd }) => ({ id, level, label, short: ussd }));
}

// ids: array of symptom ids. Unknown ids are ignored. Returns the highest level and what matched.
function classify(ids) {
  const matched = [...new Set(ids)].map((id) => BY_ID[id]).filter(Boolean);
  let level = 'none';
  for (const s of matched) if (RANK[s.level] > RANK[level]) level = s.level;
  return { level, matched: matched.map((s) => s.id), advice: ADVICE[level] };
}

function labelsFor(ids) {
  return ids.map((id) => (BY_ID[id] ? BY_ID[id].label : id));
}

module.exports = { SYMPTOMS, BY_ID, ADVICE, visibleSymptoms, classify, labelsFor };
