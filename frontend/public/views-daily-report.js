'use strict';
(function () {
  const { el, api, toast, badges } = App;

  const STATUS_AR = {
    NEW: 'جديد',
    NO_ANSWER: 'لا يوجد رد',
    FOLLOW_UP: 'متابعة',
    INTERESTED: 'مهتم',
    NOT_INTERESTED: 'غير مهتم',
    SOLD: 'تم البيع',
    CUSTOMER_WAITING: 'عميل منتظر',
  };

  App.route('/daily-report', async () => {
    const container = el('div');
    container.appendChild(el('div', { class: 'page-header' }, [
      el('div', { class: 'page-title' }, ['📊 تقرير اليوم']),
      el('div', { class: 'page-actions' }, [el('button', { class: 'btn btn-outline', onclick: () => load() }, ['🔄 تحديث'])]),
    ]));
    container.appendChild(el('div', { class: 'muted mb-16' }, [
      'تقرير مبسط بشغلك النهاردة — اضغط الزرار وابعته للتيم ليدر على واتساب.',
    ]));

    const reportWrap = el('div');
    container.appendChild(reportWrap);

    async function load() {
      reportWrap.innerHTML = '';
      let data;
      try {
        data = await api('/daily-report');
      } catch (e) {
        reportWrap.appendChild(el('div', { class: 'empty-state' }, [e.message]));
        return;
      }

      // بطاقات الإحصائيات
      const stats = el('div', { class: 'flex gap-16 wrap mb-16' }, [
        statCard('📱', 'استلمت', data.totalReceived, 'رقم'),
        statCard('✍️', 'ملاحظات', data.notesCustomers, `عميل (${data.notesTotal} ملاحظة)`),
        statCard('📞', 'مكالمات', data.callsCount, 'محاولة'),
        statCard('💬', 'واتساب', data.whatsappCount, 'عميل'),
      ]);
      reportWrap.appendChild(stats);

      const stats2 = el('div', { class: 'flex gap-16 wrap mb-16' }, [
        statCard('🔄', 'اتسحب', data.reclaimedCount, 'رقم', '#e74c3c'),
        statCard('✅', 'لسه معايا', data.remaining, 'رقم', '#27ae60'),
        statCard('⏰', 'وقت الحضور', data.checkinTime, '', '#3498db'),
      ]);
      reportWrap.appendChild(stats2);

      // تفاصيل المكالمات
      const callOutcomeEntries = Object.entries(data.callOutcomeBreakdown || {});
      if (callOutcomeEntries.length > 0) {
        const CALL_OUTCOME_AR = { ANSWERED:'رد ✅', NO_ANSWER:'مارد 📵', BUSY:'مشغول 🔴', WRONG_NUMBER:'رقم غلط ❌', SWITCHED_OFF:'مغلق 📴', REJECTED:'رفض 🚫' };
        const CALL_OUTCOME_COLORS = { ANSWERED:'#27ae60', NO_ANSWER:'#e67e22', BUSY:'#e74c3c', WRONG_NUMBER:'#95a5a6', SWITCHED_OFF:'#7f8c8d', REJECTED:'#c0392b' };
        const callCard = el('div', { class: 'card card-pad mb-16', style: 'border:2px solid var(--accent);border-radius:16px' }, [
          el('div', { style: 'font-weight:900;margin-bottom:12px;font-size:16px' }, ['📞 تفاصيل المكالمات']),
          el('div', { class: 'flex gap-8 wrap' },
            callOutcomeEntries.map(([k, n]) => el('div', {
              style: `background:${CALL_OUTCOME_COLORS[k] || '#555'};color:#fff;padding:8px 16px;border-radius:12px;font-weight:800;font-size:14px;text-align:center;min-width:80px`,
            }, [`${CALL_OUTCOME_AR[k] || k}\n${n}`]))),
        ]);
        reportWrap.appendChild(callCard);
      }

      // الحالات
      const statusEntries = Object.entries(data.statusBreakdown || {});
      if (statusEntries.length > 0) {
        const statusCard = el('div', { class: 'card card-pad mb-16' }, [
          el('div', { style: 'font-weight:800;margin-bottom:8px' }, ['📈 الحالات']),
          el('div', { class: 'flex gap-8 wrap' },
            statusEntries.map(([st, n]) => el('span', {}, [badges.status(st), ` × ${n}`]))),
        ]);
        reportWrap.appendChild(statusCard);
      }

      // بريفيو التقرير
      const preview = el('div', { class: 'card card-pad mb-16' }, [
        el('div', { style: 'font-weight:800;margin-bottom:8px' }, ['📝 نص التقرير']),
        el('pre', { style: 'white-space:pre-wrap;font-family:inherit;margin:0;line-height:1.8;background:var(--surface-2);padding:12px;border-radius:8px;font-size:14px' }, [data.reportText]),
      ]);
      reportWrap.appendChild(preview);

      // زرار الإرسال — أحمر كبير، يفتح الساعه ٥:٤٥ بس
      if (data.canSend) {
        const sendBtn = el('a', {
          href: data.waUrl,
          target: '_blank',
          rel: 'noopener',
          style: 'display:flex;align-items:center;justify-content:center;gap:10px;font-size:20px;font-weight:900;padding:20px 40px;background:#e74c3c;color:#fff;border-radius:16px;text-decoration:none;box-shadow:0 4px 16px rgba(231,76,60,.35);margin-top:24px;width:100%;',
        }, ['📩 ابعت التقرير للتيم ليدر على واتساب']);
        reportWrap.appendChild(sendBtn);
      } else {
        const lockedMsg = el('div', {
          style: 'text-align:center;margin-top:24px;padding:20px;background:var(--surface-2);border-radius:16px;color:var(--muted);font-size:15px;font-weight:700',
        }, ['🔒 زرار الإرسال هيفتح الساعة ٥:٤٥ م — بالتزامن مع سحب الأرقام']);
        reportWrap.appendChild(lockedMsg);
      }
    }

    function statCard(icon, label, value, unit, color) {
      return el('div', { class: 'card card-pad', style: `flex:1;min-width:140px;text-align:center` }, [
        el('div', { style: 'font-size:28px' }, [icon]),
        el('div', { style: `font-size:28px;font-weight:900;margin:4px 0;${color ? 'color:' + color : ''}` }, [String(value)]),
        el('div', { style: 'font-weight:700;font-size:13px' }, [label]),
        unit ? el('div', { class: 'muted', style: 'font-size:12px' }, [unit]) : null,
      ].filter(Boolean));
    }

    await load();
    return container;
  });
})();
