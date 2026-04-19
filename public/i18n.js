// Tiny i18n for Sanad-AI — no deps. Strings are keyed; swap in DOM via
// data-i18n / data-i18n-ph attrs, and in JS via window.t('key').
(function () {
  const STRINGS = {
    en: {
      // common chrome
      'app.name': 'Sanad-AI',
      'app.tagline': 'One WhatsApp for every Sanad service in Oman',
      'lang.toggle': 'العربية',
      'nav.home': 'Home',
      'nav.chat': 'Chat',
      'nav.officer': 'Officer',
      'nav.admin': 'Admin',
      'actions.refresh': 'Refresh',
      'actions.reset': 'Reset',
      'actions.open': 'Open',
      'actions.close': 'Close',
      'actions.send': 'Send',
      'actions.cancel': 'Cancel',
      'actions.save': 'Save',
      'actions.back': 'Back',
      'actions.claim': 'Claim',
      'actions.release': 'Release',
      'actions.complete': 'Complete',
      'actions.verify': 'Verify',
      'actions.reject': 'Reject',

      // landing
      'landing.title': 'One WhatsApp for every Sanad service in Oman.',
      'landing.subtitle': 'dev environment · debug mode',
      'landing.web_chat': 'Web test chatbot',
      'landing.web_chat_desc': 'Talk to the agent in the browser. Upload docs, see state, inspect tool calls.',
      'landing.officer': 'Officer dashboard',
      'landing.officer_desc': 'Marketplace → claim → handle requests from the web chat live.',
      'landing.admin': 'Admin · debug',
      'landing.admin_desc': 'DB state, offices, audit, health.',
      'landing.quicktest': 'Quick test flow',
      'landing.step1': 'Open the web chatbot and say: "I want to renew my driving licence".',
      'landing.step2': 'Follow the bot. Upload any 3 images as the "documents".',
      'landing.step3': 'Type "confirm" to submit — you\'ll get a request number.',
      'landing.step4': 'Open the officer dashboard in a second tab and click Claim on the new request.',
      'landing.step5': 'Reply from the officer side → citizen sees it in the chat within 2 seconds.',
      'landing.step6': 'Try Request OTP and paste a 6-digit number from the chat side.',

      // chat
      'chat.title': 'Web test chatbot',
      'chat.header_sub': 'simulates WhatsApp · bilingual',
      'chat.session': 'session',
      'chat.phone_label': 'Your phone (optional)',
      'chat.phone_placeholder': '+968…',
      'chat.input_placeholder': 'Type a message…',
      'chat.input_hint': 'Try: "I want to renew my driving licence" or /state',
      'chat.state_title': 'Session state',
      'chat.devcmd_title': 'Dev commands',
      'chat.trace_title': 'Last trace',
      'chat.welcome': '🤖 Welcome to the Sanad-AI assistant. Tell me what government service you need — in Arabic or English — and I will walk you through it.',
      'chat.online': 'online',
      'chat.request_no': 'Request #',
      'chat.llm_mode': 'LLM',
      'chat.toggle_dev': 'Dev view',
      'chat.typing': 'typing…',

      // officer
      'officer.title': 'Officer dashboard',
      'officer.viewas': 'View as:',
      'officer.marketplace': 'Marketplace',
      'officer.marketplace_sub': 'First click wins. Refresh is automatic.',
      'officer.myboard': 'My claimed requests',
      'officer.empty_mkt': 'No ready requests in the marketplace.',
      'officer.empty_mine': 'Nothing claimed. Grab one from the marketplace above.',
      'officer.open_chat': 'Open chat',
      'officer.detail_docs': 'Documents',
      'officer.detail_chatwith': 'Chat with citizen',
      'officer.detail_live': 'live',
      'officer.reply_placeholder': 'Type a reply to the citizen…',
      'officer.shortcuts': 'Shortcuts',
      'officer.sc.portal': 'Open portal',
      'officer.sc.otp': 'Request OTP',
      'officer.sc.civilid': 'Civil ID',
      'officer.sc.phone': 'Phone',
      'officer.sc.fee': 'Fee',
      'officer.canned.doc_unclear': 'The photo is unclear — please resend a sharper copy',
      'officer.canned.payment_received': 'Payment received ✅',
      'officer.canned.starting': 'Starting your transaction now',
      'officer.canned.wait_otp': 'Please forward the OTP when it arrives',
      'officer.otp.waiting': 'OTP window open · waiting for citizen…',
      'officer.otp.received': 'OTP received · copied to clipboard',

      // admin
      'admin.title': 'Admin · debug',
      'admin.counts': 'Counts',
      'admin.latest_req': 'Latest requests',
      'admin.latest_msg': 'Latest messages',
      'admin.utils': 'Utilities',
      'admin.sim_otp': 'Simulate OTP',
      'admin.req_id': 'request id',
      'admin.code': 'code',
      'admin.no_req': 'No requests yet.',

      // status labels (reused across all pages)
      'status.ready': 'ready',
      'status.claimed': 'claimed',
      'status.in_progress': 'in progress',
      'status.needs_more_info': 'needs more info',
      'status.on_hold': 'on hold',
      'status.completed': 'completed',
      'status.cancelled_by_citizen': 'cancelled',
      'status.cancelled_by_office': 'cancelled',
      'status.pending': 'pending',
      'status.verified': 'verified',
      'status.rejected': 'rejected',

      // bubbles (bot-side system notices are still produced by the bot in AR;
      // these are only for UI decorations)
      'bubble.attachment': 'attachment'
    },
    ar: {
      'app.name': 'سند الذكي',
      'app.tagline': 'واتساب واحد لكل خدمات سند في سلطنة عمان',
      'lang.toggle': 'English',
      'nav.home': 'الرئيسية',
      'nav.chat': 'المحادثة',
      'nav.officer': 'الموظف',
      'nav.admin': 'الإدارة',
      'actions.refresh': 'تحديث',
      'actions.reset': 'إعادة',
      'actions.open': 'فتح',
      'actions.close': 'إغلاق',
      'actions.send': 'إرسال',
      'actions.cancel': 'إلغاء',
      'actions.save': 'حفظ',
      'actions.back': 'رجوع',
      'actions.claim': 'استلام',
      'actions.release': 'إرجاع',
      'actions.complete': 'إنهاء',
      'actions.verify': 'تحقق',
      'actions.reject': 'رفض',

      'landing.title': 'مساعد واتساب واحد لكل خدمات سند في عُمان.',
      'landing.subtitle': 'بيئة تطوير · وضع التصحيح',
      'landing.web_chat': 'تجربة الشات بوت',
      'landing.web_chat_desc': 'تحدث مع المساعد من المتصفح. ارفع مستندات، راقب الحالة، وافحص استدعاءات الأدوات.',
      'landing.officer': 'لوحة الموظف',
      'landing.officer_desc': 'سوق الطلبات → استلام → متابعة الطلبات من المحادثة الحيّة.',
      'landing.admin': 'الإدارة · تصحيح',
      'landing.admin_desc': 'حالة القاعدة، المكاتب، السجل، الصحة.',
      'landing.quicktest': 'تجربة سريعة',
      'landing.step1': 'افتح الشات بوت وقل: «أريد تجديد رخصة القيادة».',
      'landing.step2': 'اتبع المساعد وارفع 3 صور كمستندات.',
      'landing.step3': 'اكتب «تأكيد» لإرسال الطلب — ستحصل على رقم.',
      'landing.step4': 'افتح لوحة الموظف في تبويب آخر واضغط «استلام».',
      'landing.step5': 'رد من جانب الموظف → يظهر للمواطن في المحادثة خلال ثانيتين.',
      'landing.step6': 'جرب «طلب OTP» والصق رقماً من 6 خانات في جانب المحادثة.',

      'chat.title': 'تجربة المساعد عبر الويب',
      'chat.header_sub': 'محاكاة واتساب · ثنائي اللغة',
      'chat.session': 'الجلسة',
      'chat.phone_label': 'رقم هاتفك (اختياري)',
      'chat.phone_placeholder': '‎+968…',
      'chat.input_placeholder': 'اكتب رسالة…',
      'chat.input_hint': 'جرب: «أريد تجديد رخصة القيادة» أو /state',
      'chat.state_title': 'حالة الجلسة',
      'chat.devcmd_title': 'أوامر المطورين',
      'chat.trace_title': 'آخر تتبع',
      'chat.welcome': '🤖 مرحباً بك في مساعد سند. أخبرني بالخدمة الحكومية التي تحتاجها وسأوجهك خطوة بخطوة.',
      'chat.online': 'متصل',
      'chat.request_no': 'طلب رقم',
      'chat.llm_mode': 'النموذج',
      'chat.toggle_dev': 'عرض المطور',
      'chat.typing': 'يكتب…',

      'officer.title': 'لوحة الموظف',
      'officer.viewas': 'عرض كـ:',
      'officer.marketplace': 'سوق الطلبات',
      'officer.marketplace_sub': 'أول نقرة تفوز. التحديث تلقائي.',
      'officer.myboard': 'طلباتي المستلمة',
      'officer.empty_mkt': 'لا توجد طلبات جاهزة في السوق.',
      'officer.empty_mine': 'لا يوجد شيء مستلم. خذ واحداً من السوق أعلاه.',
      'officer.open_chat': 'فتح المحادثة',
      'officer.detail_docs': 'المستندات',
      'officer.detail_chatwith': 'المحادثة مع المواطن',
      'officer.detail_live': 'مباشر',
      'officer.reply_placeholder': 'اكتب رداً على المواطن…',
      'officer.shortcuts': 'اختصارات',
      'officer.sc.portal': 'فتح البوابة',
      'officer.sc.otp': 'طلب OTP',
      'officer.sc.civilid': 'البطاقة المدنية',
      'officer.sc.phone': 'الهاتف',
      'officer.sc.fee': 'الرسوم',
      'officer.canned.doc_unclear': 'الصورة غير واضحة — ابعث أوضح من فضلك',
      'officer.canned.payment_received': 'تم استلام الدفع ✅',
      'officer.canned.starting': 'سأبدأ معاملتك الآن',
      'officer.canned.wait_otp': 'أرسل لنا رمز التحقق عند وصوله',
      'officer.otp.waiting': 'نافذة OTP مفتوحة · بانتظار المواطن…',
      'officer.otp.received': 'تم استلام الرمز · نُسِخ للحافظة',

      'admin.title': 'الإدارة · التصحيح',
      'admin.counts': 'الأعداد',
      'admin.latest_req': 'أحدث الطلبات',
      'admin.latest_msg': 'أحدث الرسائل',
      'admin.utils': 'أدوات',
      'admin.sim_otp': 'محاكاة OTP',
      'admin.req_id': 'رقم الطلب',
      'admin.code': 'الرمز',
      'admin.no_req': 'لا توجد طلبات بعد.',

      'status.ready': 'جاهز',
      'status.claimed': 'مستلم',
      'status.in_progress': 'قيد التنفيذ',
      'status.needs_more_info': 'يحتاج معلومات',
      'status.on_hold': 'معلق',
      'status.completed': 'مكتمل',
      'status.cancelled_by_citizen': 'ملغى',
      'status.cancelled_by_office': 'ملغى',
      'status.pending': 'بانتظار',
      'status.verified': 'تم التحقق',
      'status.rejected': 'مرفوض',

      'bubble.attachment': 'مرفق'
    }
  };

  const I18N = {
    lang: localStorage.getItem('sanad.lang') || 'en',
    t(key, fb) { return (STRINGS[this.lang] && STRINGS[this.lang][key]) || fb || key; },
    setLang(lang) {
      this.lang = (lang === 'ar' ? 'ar' : 'en');
      localStorage.setItem('sanad.lang', this.lang);
      document.documentElement.lang = this.lang;
      document.documentElement.dir = this.lang === 'ar' ? 'rtl' : 'ltr';
      this.apply();
      window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: this.lang } }));
    },
    apply() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const k = el.getAttribute('data-i18n');
        el.textContent = this.t(k);
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        const k = el.getAttribute('data-i18n-ph');
        el.setAttribute('placeholder', this.t(k));
      });
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const k = el.getAttribute('data-i18n-title');
        el.setAttribute('title', this.t(k));
      });
    }
  };

  window.I18N = I18N;
  window.t = (k, fb) => I18N.t(k, fb);

  // Apply on DOM ready
  function init() {
    document.documentElement.lang = I18N.lang;
    document.documentElement.dir = I18N.lang === 'ar' ? 'rtl' : 'ltr';
    I18N.apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
