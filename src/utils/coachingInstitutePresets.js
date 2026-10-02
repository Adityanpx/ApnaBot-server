// Coaching "What kind of institute are you?" presets for the Bot Builder.
// Each preset is a starting point the owner picks: the Bot Builder page
// replaces its sections, forms and FAQ with `settings` (keeping the welcome
// message and courses), records `instituteType`, and nothing changes on
// WhatsApp until the owner saves and publishes. "____" marks what each
// institute must fill in — publish refuses blanks
// (coachingBotSettings.js#validateCoachingSettings, forPublish).
//
// suggestedCourses are course_catalog names (category 'coaching', see
// scripts/seedCourseCatalog.js) shown first, marked "Suggested", in the
// Courses catalog picker.
//
// Every preset's settings must stay valid coaching settings (v1) — see
// coachingInstitutePresets.test.js.

const contact = 'Call or WhatsApp: ____\nAddress: ____';
const off = { enabled: false, text: '' };

const INSTITUTE_PRESETS = {
  skill: {
    title: 'Skill classes',
    hint: 'Abacus, Vedic Maths, Chess, Art, Music, Spoken English…',
    suggestedCourses: ['Abacus', 'Vedic Maths', 'Spoken English', 'Computer Basics'],
    settings: {
      sections: {
        fees: { enabled: true, text: 'Registration: ₹____\nFees: ₹____ per level (____ months each)' },
        timings: { enabled: true, text: 'Mon–Fri: ____\nSat–Sun: ____\nOnline and offline batches available.' },
        results: { enabled: true, text: 'Our students have won ____ medals at ____ competitions.' },
        material: off,
        contact: { enabled: true, text: contact },
        location: { enabled: false }
      },
      demoForm: { enabled: true, fields: ['age', 'mode', 'preferredTime'], customFields: [], note: '' },
      admissionForm: {
        enabled: true, fields: ['parentName', 'dob', 'school', 'standard', 'batch', 'area'],
        customFields: [], note: '', targetExamOptions: []
      },
      faq: {
        enabled: true,
        items: [
          { question: 'Age limit?', answer: 'Students from ____ years can join.' },
          { question: 'Online classes?', answer: 'Yes — ____.' },
          { question: 'Books included?', answer: 'The study kit is ____ (included in the fees / ₹____ extra).' }
        ]
      }
    }
  },
  competitive: {
    title: 'Competitive exams',
    hint: 'JEE, NEET, MHT-CET coaching',
    suggestedCourses: ['JEE Main + Advanced', 'NEET', 'MHT-CET', '11th Science', '12th Science'],
    settings: {
      sections: {
        fees: { enabled: true, text: 'Full course: ₹____\nInstalments: ____' },
        timings: { enabled: true, text: 'Weekday batches: ____\nWeekend batches: ____' },
        results: { enabled: true, text: 'Last year ____ of our students cleared ____. Top rank: ____.' },
        material: { enabled: true, text: 'Printed notes, practice sheets and an online test series are included.' },
        contact: { enabled: true, text: contact },
        location: { enabled: false }
      },
      demoForm: {
        enabled: true, fields: ['standard', 'board', 'stream', 'targetExam', 'mode'],
        customFields: [], note: '', targetExamOptions: ['JEE', 'NEET', 'MHT-CET']
      },
      admissionForm: {
        enabled: true,
        fields: ['fatherName', 'motherName', 'dob', 'school', 'standard', 'board', 'stream', 'tenthPercent', 'targetExam', 'batch', 'area'],
        customFields: [], note: '', targetExamOptions: ['JEE', 'NEET', 'MHT-CET']
      },
      faq: {
        enabled: true,
        items: [
          { question: 'Test series?', answer: 'Yes — a full test series with ____ mock tests.' },
          { question: 'Doubt sessions?', answer: 'Doubt sessions are held every ____.' },
          { question: 'Scholarship?', answer: 'Scholarships up to ____% based on ____.' }
        ]
      }
    }
  },
  tuition: {
    title: 'School tuition',
    hint: '8th–12th, State board / CBSE / ICSE',
    suggestedCourses: ['Foundation (8th-10th)', '11th Science', '12th Science', '11th Commerce', '12th Commerce'],
    settings: {
      sections: {
        fees: { enabled: true, text: 'Registration: ₹____\nFees: ₹____ per month' },
        timings: { enabled: true, text: 'Weekdays: ____\nWeekends: ____' },
        results: off,
        material: off,
        contact: { enabled: true, text: contact },
        location: { enabled: false }
      },
      demoForm: { enabled: true, fields: ['standard', 'board', 'school', 'preferredTime'], customFields: [], note: '' },
      admissionForm: {
        enabled: true, fields: ['parentName', 'school', 'standard', 'board', 'batch', 'area'],
        customFields: [], note: '', targetExamOptions: []
      },
      faq: {
        enabled: true,
        items: [
          { question: 'Which boards?', answer: 'We teach ____ board students.' },
          { question: 'Batch size?', answer: 'At most ____ students per batch.' },
          { question: 'Weekend batches?', answer: 'Yes — ____.' }
        ]
      }
    }
  }
};

const INSTITUTE_TYPES = Object.keys(INSTITUTE_PRESETS);

/** For GET /api/bot-settings: [{ key, title, hint, suggestedCourses, settings }]. */
const listInstitutePresets = () => INSTITUTE_TYPES.map(key => ({ key, ...INSTITUTE_PRESETS[key] }));

module.exports = { INSTITUTE_PRESETS, INSTITUTE_TYPES, listInstitutePresets };
