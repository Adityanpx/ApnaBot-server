// Catalog of system-authored, customer-facing strings that aren't tied to
// any node/edge (so they can't go through label_translations like
// node-authored copy does). Entries only need the languages they actually
// have translations for — getSystemMessage falls back to 'en', same as
// getLocalizedText falls back to the untranslated column.
//
// {{name}} marks a value filled in by the caller (getSystemMessage's vars).
// The 'en' text of every entry that replaced an inline string is exactly
// what was sent before — English customers see no change.
const SYSTEM_MESSAGES = {
  webFormPrompt: {
    en: 'Tap below to fill in your request. This link expires in 30 minutes.',
    hi: 'अपना अनुरोध भरने के लिए नीचे टैप करें। यह लिंक 30 मिनट में समाप्त हो जाएगा।',
    mr: 'तुमची विनंती भरण्यासाठी खाली टॅप करा. ही लिंक 30 मिनिटांत संपेल.'
  },
  webFormButtonText: {
    en: 'Fill booking form',
    hi: 'बुकिंग फॉर्म भरें',
    mr: 'बुकिंग फॉर्म भरा'
  },
  bookingConfirmFailedFallback: {
    en: 'Sorry, something went wrong confirming your booking — our team will reach out to you shortly.',
    hi: 'माफ़ कीजिए, आपकी बुकिंग की पुष्टि करते समय कुछ गड़बड़ हो गई — हमारी टीम जल्द ही आपसे संपर्क करेगी।',
    mr: 'माफ करा, तुमच्या बुकिंगची पुष्टी करताना काहीतरी चूक झाली — आमची टीम लवकरच तुमच्याशी संपर्क साधेल.'
  },
  webFormLinkFailedFallback: {
    en: 'Sorry, something went wrong generating your booking link — our team will reach out to you shortly.',
    hi: 'माफ़ कीजिए, आपका बुकिंग लिंक बनाते समय कुछ गड़बड़ हो गई — हमारी टीम जल्द ही आपसे संपर्क करेगी।',
    mr: 'माफ करा, तुमची बुकिंग लिंक तयार करताना काहीतरी चूक झाली — आमची टीम लवकरच तुमच्याशी संपर्क साधेल.'
  },
  paymentTriggerDefault: {
    en: 'Please complete your payment.',
    hi: 'कृपया अपना भुगतान पूरा करें।',
    mr: 'कृपया तुमचे पेमेंट पूर्ण करा.'
  },
  genericFallbackReply: {
    en: 'Thank you for your message. We will get back to you soon.',
    hi: 'आपके संदेश के लिए धन्यवाद। हम जल्द ही आपसे संपर्क करेंगे।',
    mr: 'तुमच्या संदेशाबद्दल धन्यवाद. आम्ही लवकरच तुमच्याशी संपर्क साधू.'
  },
  locationNotConfigured: {
    en: 'Sorry, our location is not set up yet.',
    hi: 'माफ़ कीजिए, हमारा लोकेशन अभी सेट नहीं किया गया है।',
    mr: 'माफ करा, आमचे लोकेशन अजून सेट केलेले नाही.'
  },
  vehicleNoLongerAvailable: {
    en: 'Sorry, that vehicle is no longer available for this route. Here are the current options:',
    hi: 'माफ़ कीजिए, यह गाड़ी इस रूट के लिए अब उपलब्ध नहीं है। ये मौजूदा विकल्प हैं:',
    mr: 'माफ करा, ही गाडी या मार्गासाठी आता उपलब्ध नाही. हे सध्याचे पर्याय आहेत:'
  },

  // ── Booking confirmation (booking.service.js#createBookingAndConfirmation) ──
  bookingReceived: {
    en: '✅ *Booking request received!*',
    hi: '✅ *बुकिंग अनुरोध मिल गया!*',
    mr: '✅ *बुकिंग विनंती मिळाली!*'
  },
  bookingIdLine: {
    en: 'Booking ID: *{{code}}*',
    hi: 'बुकिंग आईडी: *{{code}}*',
    mr: 'बुकिंग आयडी: *{{code}}*'
  },
  bookingContactSoon: {
    en: 'Our team will contact you shortly to confirm.',
    hi: 'पुष्टि के लिए हमारी टीम जल्द ही आपसे संपर्क करेगी।',
    mr: 'पुष्टीसाठी आमची टीम लवकरच तुमच्याशी संपर्क साधेल.'
  },
  // Summary lines (booking.service.js#buildBookingSummaryBody)
  summaryFare: {
    en: 'Fare: *₹{{fare}}*',
    hi: 'किराया: *₹{{fare}}*',
    mr: 'भाडे: *₹{{fare}}*'
  },
  summaryFareEstimated: {
    en: 'Fare: *₹{{fare}} (estimated, based on distance)*',
    hi: 'किराया: *₹{{fare}} (अनुमानित, दूरी के आधार पर)*',
    mr: 'भाडे: *₹{{fare}} (अंदाजे, अंतरावर आधारित)*'
  },
  summaryDistance: {
    en: 'Distance: *{{km}} km*',
    hi: 'दूरी: *{{km}} किमी*',
    mr: 'अंतर: *{{km}} किमी*'
  },
  summaryDriverDa: {
    en: 'Driver DA: *₹{{total}} ({{days}} days × ₹{{perDay}})*',
    hi: 'ड्राइवर भत्ता (DA): *₹{{total}} ({{days}} दिन × ₹{{perDay}})*',
    mr: 'ड्रायव्हर भत्ता (DA): *₹{{total}} ({{days}} दिवस × ₹{{perDay}})*'
  },
  summaryTollNote: {
    en: '_Note: Toll & parking charges are not included in this fare and will be collected separately._',
    hi: '_नोट: टोल और पार्किंग शुल्क इस किराये में शामिल नहीं हैं और अलग से लिए जाएंगे।_',
    mr: '_टीप: टोल आणि पार्किंग शुल्क या भाड्यात समाविष्ट नाही आणि ते वेगळे घेतले जाईल._'
  },
  summaryExtraRate: {
    en: '_Extra km: ₹{{km}}/km, Extra hour: ₹{{hr}}/hr beyond package limits._',
    hi: '_पैकेज सीमा से ज़्यादा: अतिरिक्त किमी ₹{{km}}/किमी, अतिरिक्त घंटा ₹{{hr}}/घंटा।_',
    mr: '_पॅकेज मर्यादेपेक्षा जास्त: अतिरिक्त किमी ₹{{km}}/किमी, अतिरिक्त तास ₹{{hr}}/तास._'
  },
  summaryRentalUnconfigured: {
    en: "_Note: this business hasn't set up rental packages yet — our team will call you to confirm pricing for this rental._",
    hi: '_नोट: इस व्यवसाय ने अभी रेंटल पैकेज सेट नहीं किए हैं — इस रेंटल की कीमत की पुष्टि के लिए हमारी टीम आपको कॉल करेगी।_',
    mr: '_टीप: या व्यवसायाने अजून रेंटल पॅकेज सेट केलेले नाहीत — या रेंटलच्या किमतीची पुष्टी करण्यासाठी आमची टीम तुम्हाला कॉल करेल._'
  },

  // ── Advance / admission fee request (booking.service.js) ──
  advanceQrIntro: {
    en: 'Almost done! To confirm your booking *{{code}}*, please pay the advance of *{{amount}}* by scanning this QR code.',
    hi: 'बस थोड़ा सा बाकी! अपनी बुकिंग *{{code}}* की पुष्टि के लिए, कृपया यह QR कोड स्कैन करके *{{amount}}* का एडवांस भुगतान करें।',
    mr: 'जवळपास झाले! तुमच्या बुकिंग *{{code}}* ची पुष्टी करण्यासाठी, कृपया हा QR कोड स्कॅन करून *{{amount}}* अ‍ॅडव्हान्स भरा.'
  },
  admissionFeeQrIntro: {
    en: 'Almost done! To confirm admission *{{code}}*, please pay the admission fee of *{{amount}}* by scanning this QR code.',
    hi: 'बस थोड़ा सा बाकी! एडमिशन *{{code}}* की पुष्टि के लिए, कृपया यह QR कोड स्कैन करके *{{amount}}* की एडमिशन फीस भरें।',
    mr: 'जवळपास झाले! प्रवेश *{{code}}* ची पुष्टी करण्यासाठी, कृपया हा QR कोड स्कॅन करून *{{amount}}* प्रवेश शुल्क भरा.'
  },
  advanceNoQr: {
    en: 'Almost done! To confirm your booking, an advance of *{{amount}}* is required. Our team will share the payment details with you shortly.\n\nBooking ID: *{{code}}*',
    hi: 'बस थोड़ा सा बाकी! अपनी बुकिंग की पुष्टि के लिए *{{amount}}* का एडवांस ज़रूरी है। हमारी टीम जल्द ही आपको भुगतान की जानकारी भेजेगी।\n\nबुकिंग आईडी: *{{code}}*',
    mr: 'जवळपास झाले! तुमच्या बुकिंगची पुष्टी करण्यासाठी *{{amount}}* अ‍ॅडव्हान्स आवश्यक आहे. आमची टीम लवकरच तुम्हाला पेमेंटची माहिती पाठवेल.\n\nबुकिंग आयडी: *{{code}}*'
  },
  admissionFeeNoQr: {
    en: 'Almost done! To confirm admission, the admission fee of *{{amount}}* is required. Our team will share the payment details with you shortly.\n\nAdmission ID: *{{code}}*',
    hi: 'बस थोड़ा सा बाकी! एडमिशन की पुष्टि के लिए *{{amount}}* की एडमिशन फीस ज़रूरी है। हमारी टीम जल्द ही आपको भुगतान की जानकारी भेजेगी।\n\nएडमिशन आईडी: *{{code}}*',
    mr: 'जवळपास झाले! प्रवेशाची पुष्टी करण्यासाठी *{{amount}}* प्रवेश शुल्क आवश्यक आहे. आमची टीम लवकरच तुम्हाला पेमेंटची माहिती पाठवेल.\n\nप्रवेश आयडी: *{{code}}*'
  },

  // ── Payment QR caption (payment.service.js#buildPaymentQrCaption) ──
  qrPay: {
    en: 'Please pay by scanning this QR code.',
    hi: 'कृपया यह QR कोड स्कैन करके भुगतान करें।',
    mr: 'कृपया हा QR कोड स्कॅन करून पेमेंट करा.'
  },
  qrPayAmount: {
    en: 'Please pay *₹{{amount}}* by scanning this QR code.',
    hi: 'कृपया यह QR कोड स्कैन करके *₹{{amount}}* का भुगतान करें।',
    mr: 'कृपया हा QR कोड स्कॅन करून *₹{{amount}}* भरा.'
  },
  qrPayCode: {
    en: 'Please pay for booking *{{code}}* by scanning this QR code.',
    hi: 'कृपया यह QR कोड स्कैन करके बुकिंग *{{code}}* का भुगतान करें।',
    mr: 'कृपया हा QR कोड स्कॅन करून बुकिंग *{{code}}* चे पेमेंट करा.'
  },
  qrPayAmountCode: {
    en: 'Please pay *₹{{amount}}* for booking *{{code}}* by scanning this QR code.',
    hi: 'कृपया यह QR कोड स्कैन करके बुकिंग *{{code}}* के लिए *₹{{amount}}* का भुगतान करें।',
    mr: 'कृपया हा QR कोड स्कॅन करून बुकिंग *{{code}}* साठी *₹{{amount}}* भरा.'
  },
  qrHowTo: {
    en: 'Paying from this phone? Save this image, then in any UPI app (GPay, PhonePe, Paytm) tap *Scan* → *Upload from gallery*.',
    hi: 'इसी फ़ोन से भुगतान कर रहे हैं? यह फ़ोटो सेव करें, फिर किसी भी UPI ऐप (GPay, PhonePe, Paytm) में *Scan* → *Upload from gallery* पर टैप करें।',
    mr: 'याच फोनवरून पेमेंट करत आहात? हा फोटो सेव्ह करा, मग कोणत्याही UPI अ‍ॅपमध्ये (GPay, PhonePe, Paytm) *Scan* → *Upload from gallery* वर टॅप करा.'
  },
  qrUpiId: {
    en: 'Or pay to UPI ID: {{upiId}}',
    hi: 'या इस UPI ID पर भुगतान करें: {{upiId}}',
    mr: 'किंवा या UPI ID वर पेमेंट करा: {{upiId}}'
  },
  qrScreenshot: {
    en: 'Please share a screenshot here after paying.',
    hi: 'भुगतान के बाद कृपया यहाँ स्क्रीनशॉट भेजें।',
    mr: 'पेमेंट केल्यानंतर कृपया येथे स्क्रीनशॉट पाठवा.'
  },

  // ── Owner marks the advance / fee paid (payment.service.js#setBookingPaymentStatus) ──
  advancePaid: {
    en: '✅ Advance received! Your booking {{code}} is confirmed. Our team will contact you shortly.',
    hi: '✅ एडवांस मिल गया! आपकी बुकिंग {{code}} पक्की हो गई है। हमारी टीम जल्द ही आपसे संपर्क करेगी।',
    mr: '✅ अ‍ॅडव्हान्स मिळाला! तुमचे बुकिंग {{code}} निश्चित झाले आहे. आमची टीम लवकरच तुमच्याशी संपर्क साधेल.'
  },
  admissionFeePaid: {
    en: '✅ Fees received! Admission {{code}} is confirmed. Welcome to {{business}}!',
    hi: '✅ फीस मिल गई! एडमिशन {{code}} पक्का हो गया है। {{business}} में आपका स्वागत है!',
    mr: '✅ फी मिळाली! प्रवेश {{code}} निश्चित झाला आहे. {{business}} मध्ये तुमचे स्वागत आहे!'
  },

  // ── Chat booking ended for inactivity (sessionTimeout.worker.js) ──
  // 'book' is the typed keyword, so it stays in English.
  sessionTimeout: {
    en: "Looks like you've stepped away — I've ended this session due to inactivity. Send 'book' anytime to start again.",
    hi: "लगता है आप व्यस्त हैं — जवाब न मिलने के कारण मैंने यह बातचीत बंद कर दी है। फिर से शुरू करने के लिए कभी भी 'book' भेजें।",
    mr: "तुम्ही व्यस्त आहात असे दिसते — प्रतिसाद न मिळाल्यामुळे मी हे संभाषण बंद केले आहे. पुन्हा सुरू करण्यासाठी कधीही 'book' पाठवा."
  },

  // ── Customer sent STOP / UNSUBSCRIBE (webhook.controller.js) ──
  // Used only when the business has no stop message of its own. 'START' is
  // the typed keyword, so it stays in English.
  stopOptOutDefault: {
    en: "Done — you won't receive offers or reminders from us. Reply START anytime to turn them back on.",
    hi: 'ठीक है — अब आपको हमारी ओर से ऑफ़र या रिमाइंडर नहीं मिलेंगे। इन्हें फिर से चालू करने के लिए कभी भी START लिखकर भेजें।',
    mr: 'ठीक आहे — आता तुम्हाला आमच्याकडून ऑफर्स किंवा रिमाइंडर्स मिळणार नाहीत. ते पुन्हा सुरू करण्यासाठी कधीही START पाठवा.'
  },

  // ── Follow-up automation default texts (utils/followup.js PRESETS) ──
  // Copied into the automation when the owner creates it (and editable
  // there); {{customerName}} is filled at send time by
  // utils/messageTemplating.js#applyMessageTemplate, not by getSystemMessage.
  // 'menu' is the typed keyword, so it stays in English.
  followupEnquiryNudge: {
    en: "Hi {{customerName}}, just checking in — did you find what you were looking for? Reply here and we'll help, or type *menu* to see options.",
    hi: 'नमस्ते {{customerName}}, बस पूछना चाहते थे — क्या आपको वह मिल गया जो आप ढूँढ रहे थे? यहाँ जवाब दें, हम मदद करेंगे, या विकल्प देखने के लिए *menu* लिखें।',
    mr: 'नमस्कार {{customerName}}, सहज विचारत आहोत — तुम्ही जे शोधत होता ते मिळाले का? इथे उत्तर द्या, आम्ही मदत करू, किंवा पर्याय पाहण्यासाठी *menu* लिहा.'
  },
  // win_back sends a template; this text is only used if the customer's
  // 24-hour window happens to be open.
  followupWinBack: {
    en: "Hi {{customerName}}, it's been a while! We'd love to help you again — reply here anytime.",
    hi: 'नमस्ते {{customerName}}, काफ़ी समय हो गया! हम फिर से आपकी मदद करना चाहेंगे — कभी भी यहाँ जवाब दें।',
    mr: 'नमस्कार {{customerName}}, बराच काळ झाला! आम्हाला पुन्हा तुमची मदत करायला आवडेल — कधीही इथे उत्तर द्या.'
  },

  // ── Free demo time + reminder (demoReminder.service.js) ──
  demoFixed: {
    en: "✅ {{student}}'s free demo class for {{course}} is fixed for {{time}}. Reply here if you need to change it.",
    hi: '✅ {{student}} की {{course}} की फ्री डेमो क्लास {{time}} को तय हुई है। बदलाव करना हो तो यहाँ जवाब दें।',
    mr: '✅ {{student}} चा {{course}} चा मोफत डेमो क्लास {{time}} ला ठरला आहे. बदल करायचा असल्यास येथे उत्तर द्या.'
  },
  demoReminder: {
    en: "⏰ Reminder: {{student}}'s free demo class for {{course}} at {{business}} is on {{time}}. Reply here if you can't make it.",
    hi: '⏰ याद दिलाना: {{student}} की {{course}} की फ्री डेमो क्लास ({{business}}) {{time}} को है। अगर आप नहीं आ पाएंगे तो यहाँ जवाब दें।',
    mr: '⏰ आठवण: {{student}} चा {{course}} चा मोफत डेमो क्लास ({{business}}) {{time}} ला आहे. येणे शक्य नसल्यास येथे उत्तर द्या.'
  }
};

const fill = (text, vars) => (vars
  ? text.replace(/\{\{(\w+)\}\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m))
  : text);

/**
 * Look up a system-authored string by key, falling back to English when
 * languageCode is missing/invalid or has no translation for this key.
 * @param {string} key - a SYSTEM_MESSAGES key
 * @param {string|null|undefined} languageCode
 * @param {Object} [vars] - values for the entry's {{name}} marks
 */
const getSystemMessage = (key, languageCode, vars) => {
  const entry = SYSTEM_MESSAGES[key];
  if (!entry) return undefined;
  if (languageCode) {
    const translated = entry[languageCode];
    if (translated !== undefined && translated !== null && String(translated).trim() !== '') {
      return fill(translated, vars);
    }
  }
  return fill(entry.en, vars);
};

module.exports = { SYSTEM_MESSAGES, getSystemMessage };
